/**
 * 知识图谱（社交网络）的类型定义。
 *
 * 结构：**有向无环图**。
 * - 节点 = 一个人物；
 * - 有向边的语义是"**A 称呼 B 为什么**"（A→B 标 `母亲`，就说明 B 是 A 的母亲；
 *   反过来 B→A 会标 `儿子`/`女儿`）。所以"关系"永远是从"谁在称呼"指向"被称呼的人"，
 *   这样一条边就同时表达了两件事：称呼词 + 称呼者视角。
 *
 * 为什么用有向边而不是无向的"关系"：
 * 无向边只能表达"两人有关系"，但有向边能表达"**谁怎么叫谁**"——
 * 这正是家人之间最常出现的信息（"我妈"、"他叫你舅舅"），而且不会在性别/长幼上出错。
 *
 * @module dsh-webhook-weixin/graph-types
 */

/**
 * 图谱的**绝对中心**：助手（欣爱）。
 *
 * 所有关系都从她的视角表达——她称呼谁、谁称呼她。查关系时不指明起点，
 * 默认就从她出发（见 `graphTools.ts`）。
 */
export const GRAPH_ASSISTANT_NAME = '欣爱'

/**
 * 用户在图谱里的规范名。
 *
 * 用"主人"而不是"我"：图谱是**欣爱的视角**，她称呼用户为"主人"，
 * 所以节点的正名就是他。真名（例如身份证上的名字）属于"逐步补充"的信息——
 * 一旦从对话里得知，节点会**就地改名**并把"主人"保留为别名，
 * 这样两个叫法都还能查到。
 */
export const GRAPH_USER_NAME = '主人'

/** 人物状态。 */
export type PersonStatus = 'alive' | 'deceased' | 'lost_contact' | 'unknown'

/** 性别。 */
export type Gender = 'male' | 'female' | 'other' | 'unknown'

/** 重要日期（生日、纪念日等）。日期允许年份未知，写成 `MM-DD`。 */
export interface ImportantDate {
  readonly label: string
  /** `YYYY-MM-DD` 或 `MM-DD`（年份未知时）。 */
  readonly date: string
}

/** 一条信息的来源，保证图谱里的每句话都能追溯回对话。 */
export interface GraphEvidence {
  /** 来源日期 `YYYY-MM-DD`。 */
  readonly date: string
  /** 依据的具体说法（用户原话片段）。 */
  readonly note: string
}

/** 一个人物节点。 */
export interface PersonNode {
  /** 稳定 id（首次出现时分配，改名字也不变）。 */
  readonly id: string
  /** 姓名（正名）。 */
  readonly name: string
  /** 别名/小名/其它叫法。 */
  readonly aliases?: readonly string[]
  /** 出生日期：`YYYY-MM-DD`，或年份未知时 `MM-DD`。 */
  readonly birthday?: string
  /** 年龄。能由生日推算时应由代码算，不靠模型记。 */
  readonly age?: number
  readonly gender?: Gender
  readonly status?: PersonStatus
  /** 联系方式（手机/微信等）。 */
  readonly contacts?: readonly string[]
  /** 所在地。 */
  readonly location?: string
  readonly occupation?: string
  /** 家庭情况（自由文本，例如"丧偶，与长子同住"）。 */
  readonly family_summary?: string
  readonly important_dates?: readonly ImportantDate[]
  /** 其它值得长期记住的事实。 */
  readonly notes?: string
  /** 最后更新时间。 */
  readonly updated_at: number
  readonly sources?: readonly GraphEvidence[]
}

/** 一条"称呼"边：from 称呼 to 为 label。 */
export interface RelationEdge {
  readonly from: string
  readonly to: string
  /** 称呼词，例如 `母亲`、`舅舅`、`朋友`。 */
  readonly label: string
  /**
   * 粗分类。
   *
   * `address` = **当面叫的称呼**（"欣爱叫主人"、"主人叫欣爱"）。它和亲属称谓的区别是：
   * 亲属称谓可以有很多个同义叫法并存（`妈`/`母亲`/`娘`），而"当面怎么叫"在任一时点
   * 只有一个当前值——所以这类边在更新时是**替换**语义，旧称呼记进 `previous_labels`。
   */
  readonly kind?: 'kinship' | 'friend' | 'colleague' | 'address' | 'other'
  /** 这类边被替换过的历史称呼（新的在前），用于"他以前叫我什么"。 */
  readonly previous_labels?: readonly string[]
  readonly updated_at: number
  readonly sources?: readonly GraphEvidence[]
}

/** 整图快照。 */
export interface GraphSnapshot {
  readonly nodes: readonly PersonNode[]
  readonly edges: readonly RelationEdge[]
}

/** 查询出的一条链路。 */
export interface GraphPath {
  /** 从起点到终点的节点 id 序列。 */
  readonly node_ids: readonly string[]
  /** 从起点到终点的人名序列（同样长度）。 */
  readonly names: readonly string[]
  /** 每一跳：`from 称呼 to 为 label`。 */
  readonly hops: readonly { from: string; to: string; label: string }[]
  /** 给模型/人读的一句话，例如"小明 → 妈妈 → 弟弟"。 */
  readonly readable: string
}

/** 构造参数。 */
export interface KnowledgeGraphOptions {
  readonly dir: string
}
