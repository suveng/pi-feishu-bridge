/**
 * 「发图片」能力单测（TC-BRIDGE-IMG-*）
 *
 * 覆盖三块：
 *   1. extractLocalImages —— 从正文里认哪些 markdown 图片引用该发出去
 *   2. uploadImage —— 上传失败一律降级为 undefined，不抛
 *   3. sendLocalImage —— reply 优先、否则平铺；上传失败就不发
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLocalImages,
  sendLocalImage,
  uploadImage,
} from "../src/feishu/image-send.ts";

/** 造一个临时工作区，里面放几张真图（内容不重要，extract 只看存在性与扩展名） */
function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-img-"));
  const png = join(dir, "a.png");
  const jpg = join(dir, "sub.jpg");
  writeFileSync(png, "png-bytes");
  writeFileSync(jpg, "jpg-bytes");
  writeFileSync(join(dir, "notes.txt"), "not an image");
  return { dir, png, jpg };
}

test("TC-BRIDGE-IMG-01 绝对路径的 markdown 图片被识别", () => {
  const { png } = makeWorkspace();
  const refs = extractLocalImages(`看图：\n![示例](${png})\n`, process.cwd());
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, png);
  assert.equal(refs[0].alt, "示例");
});

test("TC-BRIDGE-IMG-02 相对路径按传入的 cwd 解析", () => {
  const { dir, jpg } = makeWorkspace();
  const refs = extractLocalImages("![](sub.jpg)", dir);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, jpg);
});

test("TC-BRIDGE-IMG-03 网络图片与 data URI 一律跳过", () => {
  const text = [
    "![](https://example.com/a.png)",
    "![](http://example.com/b.jpg)",
    "![](data:image/png;base64,AAAA)",
  ].join("\n");
  assert.deepEqual(extractLocalImages(text, process.cwd()), []);
});

test("TC-BRIDGE-IMG-04 文件不存在或扩展名不是图片时跳过", () => {
  const { dir } = makeWorkspace();
  const text = ["![](missing.png)", "![](notes.txt)"].join("\n");
  assert.deepEqual(extractLocalImages(text, dir), []);
});

test("TC-BRIDGE-IMG-05 同一张图重复引用只发一次", () => {
  const { png } = makeWorkspace();
  const text = `![a](${png})\n![b](${png})`;
  const refs = extractLocalImages(text, process.cwd());
  assert.equal(refs.length, 1);
});

test("TC-BRIDGE-IMG-06 普通链接与行内代码不误判", () => {
  const { png } = makeWorkspace();
  const text = [
    `[打开图片](${png})`, // 不是图片语法
    "清理路径 `![x](/tmp/x.png)`", // 反引号里的示例不处理（正则只认 ![]()，会命中但文件不存在）
  ].join("\n");
  assert.deepEqual(extractLocalImages(text, process.cwd()), []);
});

test("TC-BRIDGE-IMG-07 上传成功返回 image_key", async () => {
  const { png } = makeWorkspace();
  const client = {
    im: {
      image: {
        create: async () => ({ data: { image_key: "img_v2_abc" } }),
      },
    },
  };
  assert.equal(await uploadImage(client, png), "img_v2_abc");
});

test("TC-BRIDGE-IMG-08 上传报错降级为 undefined，不抛", async () => {
  const { png } = makeWorkspace();
  const client = {
    im: {
      image: {
        create: async () => {
          throw new Error("99991672 no permission");
        },
      },
    },
  };
  assert.equal(await uploadImage(client, png), undefined);
});

test("TC-BRIDGE-IMG-09 有回复锚点时用 reply 发图", async () => {
  const { png } = makeWorkspace();
  const calls: any[] = [];
  const client = {
    im: {
      image: { create: async () => ({ data: { image_key: "k1" } }) },
      message: {
        reply: async (arg: any) => {
          calls.push({ kind: "reply", arg });
          return { data: { message_id: "om_reply" } };
        },
        create: async () => {
          throw new Error("不该走 create");
        },
      },
    },
  };
  const id = await sendLocalImage(client, { replyToMessageId: "om_src" }, png);
  assert.equal(id, "om_reply");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arg.path.message_id, "om_src");
  assert.equal(calls[0].arg.data.msg_type, "image");
  assert.deepEqual(JSON.parse(calls[0].arg.data.content), { image_key: "k1" });
});

test("TC-BRIDGE-IMG-10 没有回复锚点时平铺发到 chat", async () => {
  const { png } = makeWorkspace();
  const calls: any[] = [];
  const client = {
    im: {
      image: { create: async () => ({ data: { image_key: "k2" } }) },
      message: {
        reply: async () => {
          throw new Error("不该走 reply");
        },
        create: async (arg: any) => {
          calls.push(arg);
          return { data: { message_id: "om_new" } };
        },
      },
    },
  };
  const id = await sendLocalImage(client, { chatId: "oc_chat" }, png);
  assert.equal(id, "om_new");
  assert.equal(calls[0].params.receive_id_type, "chat_id");
  assert.equal(calls[0].data.receive_id, "oc_chat");
});

test("TC-BRIDGE-IMG-11 上传失败时根本不发消息", async () => {
  const { png } = makeWorkspace();
  let sent = 0;
  const client = {
    im: {
      image: {
        create: async () => {
          throw new Error("boom");
        },
      },
      message: {
        reply: async () => {
          sent += 1;
          return { data: {} };
        },
        create: async () => {
          sent += 1;
          return { data: {} };
        },
      },
    },
  };
  assert.equal(await sendLocalImage(client, { replyToMessageId: "om_src" }, png), undefined);
  assert.equal(sent, 0);
});

test("TC-BRIDGE-IMG-12 既无回复锚点也无 chat 时直接返回 undefined", async () => {
  const { png } = makeWorkspace();
  const client = {
    im: {
      image: { create: async () => ({ data: { image_key: "k3" } }) },
      message: {
        reply: async () => {
          throw new Error("不该走 reply");
        },
        create: async () => {
          throw new Error("不该走 create");
        },
      },
    },
  };
  assert.equal(await sendLocalImage(client, {}, png), undefined);
});
