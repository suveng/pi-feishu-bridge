import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildArchiveSection,
  isArchiveFile,
  isSupportedTextFile,
  sanitizeAttachmentName,
  saveArchiveToInbox,
} from "../src/feishu/attachments.ts";

test("isArchiveFile 只认压缩包扩展名，大小写不敏感", () => {
  assert.equal(isArchiveFile("app_logs_2026-09-22T00-10-34.723485.zip"), true);
  assert.equal(isArchiveFile("LOGS.ZIP"), true);
  assert.equal(isArchiveFile("report.tar.gz"), false);
  assert.equal(isArchiveFile("app.log"), false);
  assert.equal(isArchiveFile("zip"), false);
});

test("压缩包不会被当成文本文件读", () => {
  assert.equal(isSupportedTextFile("app_logs.zip"), false);
});

test("sanitizeAttachmentName 去掉路径分隔符与 .. 前缀", () => {
  assert.equal(sanitizeAttachmentName("app_logs.zip"), "app_logs.zip");
  assert.equal(sanitizeAttachmentName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeAttachmentName("..\\..\\a.zip"), "a.zip");
  assert.equal(sanitizeAttachmentName("/tmp/底层日志.zip"), "底层日志.zip");
  assert.equal(sanitizeAttachmentName(".."), "attachment");
  assert.equal(sanitizeAttachmentName(""), "attachment");
  assert.equal(sanitizeAttachmentName("a\u0000b.zip"), "ab.zip");
});

test("saveArchiveToInbox 按消息 ID 落盘并可原样读回", () => {
  const base = mkdtempSync(join(tmpdir(), "feishu-inbox-"));
  try {
    const bytes = Buffer.from("PK\u0003\u0004fake-zip-bytes", "binary");
    const saved = saveArchiveToInbox("om_msg_1", "app_logs.zip", bytes, base);
    assert.equal(saved, join(base, "om_msg_1", "app_logs.zip"));
    assert.equal(existsSync(saved), true);
    assert.deepEqual(readFileSync(saved), bytes);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("saveArchiveToInbox 会拦截带路径穿越的附件名", () => {
  const base = mkdtempSync(join(tmpdir(), "feishu-inbox-"));
  try {
    const saved = saveArchiveToInbox("om_msg_2", "../../evil.zip", Buffer.from("x"), base);
    assert.equal(saved, join(base, "om_msg_2", "evil.zip"));
    assert.equal(existsSync(join(base, "evil.zip")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("buildArchiveSection 带出本地路径、体积与解压提示", () => {
  const section = buildArchiveSection("app_logs.zip", "/tmp/inbox/om_1/app_logs.zip", 2_517_000);
  assert.match(section, /\[Feishu archive: app_logs\.zip\]/);
  assert.match(section, /\/tmp\/inbox\/om_1\/app_logs\.zip（2\.4 MB）/);
  assert.match(section, /unzip -l/);
  assert.match(section, /python3 -m zipfile -l/);
});
