import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "./config.ts";

export type FeishuImageInput = { type: "image"; data: string; mimeType: string };

const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const SUPPORTED_TEXT_EXT = new Set([
  ".txt", ".md", ".csv", ".json", ".log",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".java", ".go", ".rs", ".rb", ".php", ".swift",
  ".kt", ".kts", ".scala", ".sh", ".bash", ".zsh",
  ".sql", ".yaml", ".yml", ".xml", ".html", ".css", ".scss",
  ".less", ".vue", ".svelte", ".toml", ".ini", ".conf", ".env",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".cs",
]);
const SUPPORTED_TEXT_BASENAME = new Set(["dockerfile", "makefile", ".gitignore"]);
/**
 * 压缩包：不当文本读，也不当「类型不支持」丢掉。
 * 背景：客户端诊断会把 app_logs_*.zip 发进飞书，直接丢弃等于诊断断在半路。
 */
const SUPPORTED_ARCHIVE_EXT = new Set([".zip"]);
const MAX_TEXT_FILE_BYTES = 800_000;
const MAX_TEXT_FILE_CHARS = 16_000;
/** 压缩包落地目录（收件箱），agent 从这里自己解压读取 */
const INBOX_DIR = join(ROOT_DIR, "inbox");

export function isSupportedImageMime(mimeType: string | undefined): mimeType is string {
  return Boolean(mimeType && SUPPORTED_IMAGE_MIME.has(mimeType));
}

export function isSupportedTextFile(fileName: string) {
  const lower = fileName.toLowerCase();
  if (SUPPORTED_TEXT_BASENAME.has(lower)) return true;
  const idx = lower.lastIndexOf(".");
  if (idx < 0) return false;
  return SUPPORTED_TEXT_EXT.has(lower.slice(idx));
}

/** 是否是压缩包附件（按扩展名判断） */
export function isArchiveFile(fileName: string) {
  const lower = fileName.toLowerCase();
  const idx = lower.lastIndexOf(".");
  if (idx < 0) return false;
  return SUPPORTED_ARCHIVE_EXT.has(lower.slice(idx));
}

/**
 * 清洗附件名 / 消息 ID，只留安全文件名。
 * 必须做：附件名来自用户，`../../x.zip` 这类会把落地路径带出目录。
 */
export function sanitizeAttachmentName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "attachment";
}

/**
 * 压缩包落盘到收件箱，返回绝对路径。
 * 为什么落盘而不是解压进 prompt：日志包动辄几十 MB，塞进上下文只会被截断。
 * 落盘后由 agent 自己 unzip/grep，诊断链路才是闭环的。
 *
 * 注：文档类附件（pdf/Office）也走这里 —— 都是「二进制、需要先落盘再由 agent 转换」。
 */
export function saveArchiveToInbox(messageId: string, fileName: string, bytes: Buffer, baseDir = INBOX_DIR) {
  const dir = join(baseDir, sanitizeAttachmentName(messageId));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sanitizeAttachmentName(fileName));
  writeFileSync(path, bytes);
  return path;
}

function formatBytes(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

/** 生成压缩包在 prompt 里的说明段（含本地路径与解压提示） */
export function buildArchiveSection(fileName: string, path: string, bytes: number) {
  return [
    `[Feishu archive: ${fileName}]`,
    `已保存到本地：${path}（${formatBytes(bytes)}）`,
    `这是压缩包，未解压。先用 \`unzip -l "${path}"\`（或 \`python3 -m zipfile -l "${path}"\`）看条目，再解压需要的文件读取内容。`,
  ].join("\n");
}

/**
 * 文档类附件：pdf / Office / 电子书。
 * 单独一类的原因：既不是可解码文本（二进制），也不是压缩包，
 * 但业务上必须能读 —— 合同、报表、需求文档都以这些格式发进飞书。
 * 打法和压缩包一致：落盘到收件箱，把路径 + 转换命令交给 agent，由 agent 自己转成文本。
 */
const SUPPORTED_DOCUMENT_EXT = new Set([
  ".pdf", ".doc", ".docx", ".rtf", ".odt",
  ".xls", ".xlsx", ".ppt", ".pptx", ".epub",
]);

/** 是否是文档类附件（按扩展名判断，与压缩包/文本文件互斥） */
export function isDocumentFile(fileName: string) {
  const lower = fileName.toLowerCase();
  const idx = lower.lastIndexOf(".");
  if (idx < 0) return false;
  return SUPPORTED_DOCUMENT_EXT.has(lower.slice(idx));
}

/**
 * 生成文档类附件在 prompt 里的说明段：本地路径 + 按扩展名给的可直接复制命令。
 * 统一用 `sys.argv[1]` 传路径，避免文件名里的引号/空格把命令打断。
 */
export function buildDocumentSection(fileName: string, path: string, bytes: number) {
  const lower = fileName.toLowerCase();
  const lines = [
    `[Feishu document: ${fileName}]`,
    `已保存到本地：${path}（${formatBytes(bytes)}）`,
    "这是二进制文档，直接读会乱码。先转成文本再读，按扩展名选一条：",
  ];
  if (/\.(docx?|rtf|odt)$/.test(lower)) {
    lines.push(`- Word/RTF：\`textutil -convert txt -stdout "${path}"\`（macOS 自带；其他平台用 \`pandoc "${path}" -t plain\`）`);
  } else if (lower.endsWith(".pdf")) {
    lines.push(
      `- PDF：\`python3 -c "import sys;from pypdf import PdfReader;[print(p.extract_text() or '') for p in PdfReader(sys.argv[1]).pages]" "${path}"\``,
    );
    lines.push("- 没装 pypdf 就先 `python3 -m pip install --user pypdf`；装了 poppler 的话 `pdftotext 文件 -` 更省事");
  } else if (/\.(xlsx?)$/.test(lower)) {
    lines.push(
      `- Excel：\`python3 -c "import sys,openpyxl;wb=openpyxl.load_workbook(sys.argv[1],data_only=True);[print(ws.title,ws.max_row,ws.max_column) for ws in wb]" "${path}"\`（先看有几个工作表，再逐表取值）`,
    );
  } else if (/\.(pptx?)$/.test(lower)) {
    lines.push("- PPT：先另存为 PDF 再按 PDF 提取；或 `python3 -m pip install --user python-pptx` 后读每个 shape 的 text");
  } else {
    lines.push(`- 先用 \`file "${path}"\` 确认真实格式，再选对应工具`);
  }
  return lines.join("\n");
}

export function decodeTextFile(fileName: string, bytes: Buffer): { ok: true; text: string; truncated: boolean } | { ok: false } {
  const slice = bytes.length > MAX_TEXT_FILE_BYTES ? bytes.subarray(0, MAX_TEXT_FILE_BYTES) : bytes;
  if (looksBinary(slice)) return { ok: false };
  const text = slice.toString("utf8");
  const truncated = text.length > MAX_TEXT_FILE_CHARS || bytes.length > MAX_TEXT_FILE_BYTES;
  return { ok: true, text: text.slice(0, MAX_TEXT_FILE_CHARS), truncated };
}

export function detectImageMime(bytes: Buffer, headerMime?: string) {
  if (headerMime && SUPPORTED_IMAGE_MIME.has(headerMime)) return headerMime;
  if (bytes.length >= 12) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) return "image/webp";
  }
  return undefined;
}

export function detectCodeLanguage(fileName: string) {
  const lower = fileName.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  const mapping: Record<string, string> = {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx",
    ".py": "python", ".java": "java", ".go": "go", ".rs": "rust", ".rb": "ruby",
    ".php": "php", ".swift": "swift", ".kt": "kotlin", ".kts": "kotlin",
    ".scala": "scala", ".sh": "bash", ".bash": "bash", ".zsh": "bash",
    ".sql": "sql", ".yaml": "yaml", ".yml": "yaml", ".xml": "xml",
    ".html": "html", ".css": "css", ".scss": "scss", ".less": "less",
    ".vue": "vue", ".svelte": "svelte", ".toml": "toml", ".ini": "ini",
    ".conf": "conf", ".env": "bash", ".c": "c", ".cc": "cpp", ".cpp": "cpp",
    ".h": "c", ".hpp": "cpp", ".cs": "csharp", ".md": "markdown",
    ".json": "json", ".csv": "csv", ".txt": "text", ".log": "text",
  };
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  return mapping[ext] || "text";
}

function looksBinary(bytes: Buffer) {
  if (!bytes.length) return false;
  let controlCount = 0;
  const sampleLen = Math.min(bytes.length, 4096);
  for (let i = 0; i < sampleLen; i += 1) {
    const ch = bytes[i]!;
    if (ch === 0) return true;
    if (ch < 8 || (ch > 13 && ch < 32)) controlCount += 1;
  }
  return controlCount / sampleLen > 0.08;
}
