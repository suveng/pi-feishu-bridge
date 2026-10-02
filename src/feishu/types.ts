export type Domain = "feishu" | "lark";
export type GroupPolicy = "open" | "mention";
export type CardActionMode = "webhook" | "ws";

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  domain: Domain;
  groupPolicy: GroupPolicy;
  /**
   * 群聊关键词触发（与 mention 叠加）：正文命中任一关键词即可，无需 @。
   * 匹配：去空白后大小写不敏感子串。
   */
  groupKeywords?: string[];
  /**
   * 群聊跟帖触发（与 mention 叠加）：回复本 bot 消息时触发，无需再 @。
   * 默认 false。
   */
  groupAlsoOnReply?: boolean;
  /** 是否忽略 sender_type=bot 的消息；默认 true */
  ignoreBotMessages?: boolean;
  cardActionMode?: CardActionMode;
  cardActionWebhookHost?: string;
  cardActionWebhookPort?: number;
  cardActionWebhookPath?: string;
  language?: "zh" | "en";
  reactEmoji?: string;
  autoStart?: boolean;
  /** Long-task notice threshold in seconds (0 disables). */
  promptNotifySec?: number;
  /** Hard prompt timeout in seconds (0 waits indefinitely). */
  promptTimeoutSec?: number;
  /** 解析入站 interactive 卡片（默认 true） */
  parseInteractiveCards?: boolean;
  /** 用户回复/引用消息时展开 parent/root 正文（默认 true） */
  includeQuotedMessage?: boolean;
  /** 引用消息并入 prompt 的最大字符数 */
  quotedMessageMaxChars?: number;
  /** 出站 API 最大重试次数（不含首次） */
  sendMaxRetries?: number;
  /**
   * 是否启用流式回复（默认 true）。
   * 使用飞书 CardKit streaming_mode，客户端按 print_step 逐字打印。
   */
  streamingReply?: boolean;
  /**
   * 正在生成回复时又收到新消息的处理方式：
   * - queue（默认）：排队，等上一条跑完再处理
   * - interrupt：立即打断当前生成，用新消息开新一轮
   * 可通过 /delivery 卡片或 /config messageDelivery 修改。
   */
  messageDelivery?: "queue" | "interrupt";
  /** CardKit 客户端打印间隔 ms（默认 50） */
  streamPrintFrequencyMs?: number;
  /** CardKit 每次打印字符数（默认 1） */
  streamPrintStep?: number;
  /** 服务端推送 fullText 到 CardKit 的间隔 ms（默认 120） */
  streamPushIntervalMs?: number;
  /**
   * 工具执行过程展示档位（默认 steps）。
   * off 不展示；steps 累积清单；action 只显示当前工具；timeout 超阈值才提示。
   * 修改方式：飞书 `/config progressMode <值>` 或 Pi `/feishu progress <值>`。
   */
  progressMode?: "off" | "steps" | "action" | "timeout";
  /** 清单最多保留多少行，超出折叠（默认 50） */
  progressMaxLines?: number;
  /** 超过该秒数才显示耗时（默认 30） */
  progressTimeoutSeconds?: number;
  /** @deprecated 兼容旧配置 */
  streamFlushMs?: number;
  streamMinChars?: number;
  streamFirstFlushMs?: number;
  streamMaxBodyChars?: number;
  /** 进化审批（/learn 应用 的授权通道）；未配置则 /learn 应用 不可用 */
  learnApproval?: LearnApprovalConfig;
};

/**
 * 进化审批配置。
 *
 * 审批人与表单结构不在这里，而在飞书审批后台的**审批定义**里：
 * 建一个审批（例如「Pi 进化审批」），放一个「多行文本」控件，审批人设为本人，
 * 再把它的 approval_code 填到这里。表单控件由代码自动识别，无需手填控件 id。
 */
export type LearnApprovalConfig = {
  /** 飞书审批定义的 approval_code */
  approvalCode: string;
  /** 等审批的超时秒数（默认 600，即 10 分钟） */
  timeoutSec?: number;
  /** 轮询审批状态的间隔秒数（默认 5） */
  pollIntervalSec?: number;
};

export type ModelSelection = {
  provider: string;
  id: string;
  /** 思考强度档位（可选，Harness 适配器持久化用；Pi 存在会话内部）。 */
  thinkingLevel?: string;
};

export type FeishuState = {
  sessions: Record<string, string>;
  models?: Record<string, ModelSelection>;
  workspaces?: Record<string, string>;
};

export type FeishuRoute = {
  sessionKey: string;
  sessionId?: string;
  chatId: string;
  chatType: "p2p" | "group";
  threadMessageId?: string;
  lastMessageId: string;
  /** 最近一条消息的发送者 open_id：进化审批要拿它当审批发起人 */
  senderOpenId?: string;
  updatedAt: number;
};

export type FeishuJobRoute = FeishuRoute & {
  jobId: string;
  jobName?: string;
  createdAt: number;
};

export type FeishuBridgeState = {
  version: 1;
  routes: Record<string, FeishuRoute>;
  jobs: Record<string, FeishuJobRoute>;
  sent: Record<string, number>;
};

export type FeishuMessage = {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  chatMode?: "p2p" | "group" | "topic";
  senderOpenId: string;
  msgType: string;
  content: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  mentions?: unknown[];
};

export type FeishuAttachment = {
  kind: "image" | "file";
  fileKey: string;
  fileName?: string;
};

export type FeishuCardAction = {
  messageId: string;
  chatId?: string;
  operatorOpenId: string;
  token?: string;
  value: unknown;
  /**
   * 表单容器（form）提交时才有：key 为表单内组件 name，value 为用户提交的值。
   * 普通按钮点击时为 undefined。飞书表单提交的事件 tag 依然是 button，
   * 只是多了这个字段，所以不能靠 tag 区分。
   */
  formValue?: unknown;
};

export type FeishuCopyMarkdownAction = {
  copySourceId: string;
};

export type FeishuStatus =
  | "not configured"
  | "connecting"
  | "connected"
  | "owned"
  | "bot unavailable"
  | "disconnected";

export type ParsedMessageInput = {
  text: string;
  attachments: FeishuAttachment[];
  /** 解析来源标记，便于调试 */
  source?: string;
};
