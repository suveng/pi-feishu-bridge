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
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLocalImages,
  flushLocalImages,
  sendLocalImage,
  stripLocalImageMarkdown,
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

test("TC-BRIDGE-IMG-06 普通链接不误判、行内代码里的示例因文件不存在被跳过", () => {
  const { dir, png } = makeWorkspace();
  // 路径必须由本用例自己造：早先写死 /tmp/x.png，机器上只要真存在这个文件就会误报
  // （2026-10-23 实测被一个遗留的 /tmp/x.png 打红）。
  const ghost = join(dir, "ghost.png");
  assert.equal(existsSync(ghost), false);
  const text = [
    `[打开图片](${png})`, // 普通 markdown 链接，不是图片语法
    `清理路径 \`![x](${ghost})\``, // 行内代码里的示例：正则仍会命中，但文件不存在 → 跳过
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

test("TC-BRIDGE-IMG-16 上传时交给 SDK 的是 Buffer，不是可读流（EPIPE 根因）", async () => {
  const { png } = makeWorkspace();
  let received: any;
  const client = {
    im: {
      image: {
        create: async (arg: any) => {
          received = arg.data.image;
          return { data: { image_key: "k-buffer" } };
        },
      },
    },
  };
  assert.equal(await uploadImage(client, png), "k-buffer");
  assert.equal(Buffer.isBuffer(received), true);
  assert.equal(typeof received.pipe, "undefined");
});

test("TC-BRIDGE-IMG-17 网络类错误重试后成功", async () => {
  const { png } = makeWorkspace();
  let calls = 0;
  const client = {
    im: {
      image: {
        create: async () => {
          calls += 1;
          if (calls === 1) throw new Error("write EPIPE");
          return { data: { image_key: "k-retry" } };
        },
      },
    },
  };
  assert.equal(await uploadImage(client, png), "k-retry");
  assert.equal(calls, 2);
});

test("TC-BRIDGE-IMG-18 权限类错误不重试，直接降级", async () => {
  const { png } = makeWorkspace();
  let calls = 0;
  const client = {
    im: {
      image: {
        create: async () => {
          calls += 1;
          throw new Error("99991672 no permission");
        },
      },
    },
  };
  assert.equal(await uploadImage(client, png), undefined);
  assert.equal(calls, 1);
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
  // 非话题群不能多带 reply_in_thread，否则会把普通回复变成话题
  assert.equal(calls[0].arg.data.reply_in_thread, undefined);
});

test("TC-BRIDGE-IMG-09b 话题群发图带 reply_in_thread，否则图落在话题外", async () => {
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
  // replyInThread=true 是话题群的唯一标记：飞书 reply 默认把消息挂在群主消息流，
  // 不带这个字段就跑到话题外（2026-10-29 实测用户看不到图）
  const id = await sendLocalImage(client, { replyToMessageId: "om_src", replyInThread: true }, png);
  assert.equal(id, "om_reply");
  assert.equal(calls[0].arg.data.reply_in_thread, true);
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

test("TC-BRIDGE-IMG-13 卡片正文里本地图片语法降级成文字（否则整卡 200570 被拒、卡死在回复中）", () => {
  const text = "看图：\n![后台批量金币扣除](/tmp/a.png)\n下面是说明。";
  const out = stripLocalImageMarkdown(text);
  assert.equal(out.includes("/tmp/a.png"), false);
  assert.match(out, /（图片见下：后台批量金币扣除）/);
  assert.match(out, /下面是说明。/);
  // 没有说明文字时也要降级，不能把路径留在卡里
  assert.equal(stripLocalImageMarkdown("![x](/tmp/b.jpg)"), "（图片见下：x）");
  assert.equal(stripLocalImageMarkdown("![](/tmp/c.gif)"), "（图片见下）");
});

test("TC-BRIDGE-IMG-14 网络图片与普通文字原样保留", () => {
  assert.equal(stripLocalImageMarkdown("![远程](https://x.test/a.png)"), "![远程](https://x.test/a.png)");
  assert.equal(stripLocalImageMarkdown("没有任何图片的正文"), "没有任何图片的正文");
  assert.equal(stripLocalImageMarkdown(""), "");
});

test("TC-BRIDGE-IMG-15 回复收尾发图用的是原文（卡片正文才 strip），否则图永远发不出去", async () => {
  // 2026-10-28 的真实缺陷：finishFinal 把 stripLocalImageMarkdown(this.body) 传给
  // flushLocalImages，而 flushLocalImages 靠 `![](路径)` 抽图 → 抽到 0 张，
  // 用户连续三次反馈「怎么没看到图」而日志里 feishu.reply_card.local_images 一条都没有。
  // 这里从 ReplyCard 收尾链路一路走到发图，锁住「必须用原文」这条不变量。
  const { ReplyCard } = await import("../src/feishu/reply-card.ts");
  const { dir, png } = makeWorkspace();
  const sent: string[] = [];
  const transport = {
    replyLocalImage: async (_id: string, p: string) => {
      sent.push(p);
      return "om_fake_image";
    },
    updateCard: async () => undefined,
  };
  const card = new ReplyCard(
    "p2p:test",
    { replyToMessageId: "om_parent" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport as any,
    { progressMode: false } as any,
  );
  await card.completeWithAnswer(`登录页动效见下：![登录页动效](${png})`);
  assert.deepEqual(sent, [png], `应把 ${png} 发出去，实际发出 ${sent.length} 张`);
  assert.ok(dir);
});

test("TC-BRIDGE-IMG-19 被新消息打断（stopped）也要把正文里的图发出去", async () => {
  // 2026-11-06 事故：一条回复里写了 5 张设计稿的 markdown，紧接着弹选择题；
  // 用户回话触发 interrupted_by_new_message → 卡片 status=stopped →
  // 旧实现 `if (status !== "done") return 0` 直接吞掉，5 张图一张没发。
  // 正文里已经写出来的图就是用户该看到的内容，中断不该改变这件事。
  const { png } = makeWorkspace();
  const sent: string[] = [];
  const got = await flushLocalImages({
    body: `稿1：![稿1](${png})`,
    status: "stopped",
    target: { replyToMessageId: "om_parent", replyInThread: true },
    transport: {
      replyLocalImage: async (_id: string, p: string) => {
        sent.push(p);
        return "om_fake_image";
      },
    },
  });
  assert.equal(got, 1, `stopped 轮次应发出 1 张，实际 ${got} 张`);
  assert.deepEqual(sent, [png]);
});

test("TC-BRIDGE-IMG-20 失败轮次不发图", async () => {
  const { png } = makeWorkspace();
  const sent: string[] = [];
  const got = await flushLocalImages({
    body: `稿1：![稿1](${png})`,
    status: "failed",
    target: { replyToMessageId: "om_parent" },
    transport: {
      replyLocalImage: async (_id: string, p: string) => {
        sent.push(p);
        return "om_fake_image";
      },
    },
  });
  assert.equal(got, 0);
  assert.deepEqual(sent, []);
});
