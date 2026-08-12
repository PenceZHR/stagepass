# 项目图谱：能飞进去的三维依赖图

2026-08-12 · 用户拍板：立体、能飞进去（WebGL）、生成类文件不上图只给目录、
「关键代码」的判据在面板上勾。

## 问题

`src/graph/` 已经有一套完整的图引擎，**但它是座孤岛**：

| 已有 | 状态 |
|---|---|
| `module-graph.ts` | 真 TS 编译器解析真依赖，`dependenciesOf` / `closureOf` / `dependentsOf` / `blastRadiusOf` 全在，有测试 |
| `ingredients.ts` | 配料单（只给签名不给实现），有测试 |
| `reconcile.ts` | 两张图对账，有测试 |
| 表 | 没有 |
| 路由 | 没有 |
| 界面 | 一个字都没有 |

`grep graph src/web src/db src/work` 只命中 `changeStore.graphOf()` —— 那是**阶段图**，
和文件图没有关系。所以这一轮要做的不是引擎，是**把引擎接到面板上，变成能点的东西**。

## 量出来的真数据（不是估的）

判据：`git ls-files` 里的 `.ts`，去掉 `.d.ts`，去掉 `archive/`。

| | 跟踪文件 | 代码模块 | 边 | 组 | 环 | 图外边 |
|---|---|---|---|---|---|---|
| demo（小游戏，PRJ-001） | 555 | **118**（21%） | 238 | 4 | 0 | **2** |
| stagepass 自己 | 331 | 117 | 463 | 9 | 0 | 0 |

**79% 的文件对结构没有信息量** —— 这就是「生成类给个目录」在数字上的样子：
`.meta` 150 个（Cocos 伴生）、`.md` 142 个、`.png` 30 个、`.wav` 9 个。

代码文件**不深**：demo 是 `tests/X.test.ts`（2 层）+ `assets/scripts/{core,view3d,game}/X.ts`
（4 层），真正的分组只有一层。那个「最深 8 层」全在 `assets/resources/art` 里 ——
正是被排除的那部分。所以**一组一张盘是忠实的，不是压扁**。

爆炸半径排头四个全在 `core`，全是配置：

```
core/GameConfig.ts      46 / 118   (39%)
core/Geometry.ts        44
core/TrafficConfig.ts   30
core/LevelConfig.ts     25
```

耗时（`git ls-files` → 读盘 → 解析 → 118 个爆炸半径全算）：

```
demo        194ms   (20 + 23 + 148 + 3)
stagepass   203ms   (17 + 35 + 145 + 6)
```

**200ms ⇒ 不缓存。** 和 ASSETS 那条 `no-store`（`panel-server.ts:1919`）同一个理由：
缓存会静默显示上一版，读起来就像「改动没生效」。不缓存 = 没有失效问题，
图永远等于磁盘上那棵树。

## 形态

### 层 = 盘，高度 = 依赖方向

一组一张浮空圆盘，从下往上堆，**高度就是依赖方向**（demo：`core` 最底，
`tests` 最顶）。这样「只许往下依赖」在图上是**看得出来的** ——
一条向上的边就是一条违规，不用读报表。

力导向图给不了这个，它把方向甩没了；而 118 个节点 / 238 条边做力导向就是毛线球，
换成三维只是三维毛线球。

### 节点越靠中心越危险

每张盘上按爆炸半径降序、葵花螺旋由内向外排。`core` 盘正中那几颗大的就是
「改它砸小半棵树」的那几个 —— **位置本身在说话**，不用读数字。

### 边默认不画

238 条全画就是毛线球。点一个文件才亮：

- 绿线 = 它依赖谁
- 橙线 = 谁依赖它
- 半透明 = 爆炸半径里被间接波及的
- **断头的边** = `unresolved`（见「错误处理」第 1 条）

### 飞进去必须有回报：三档 LOD

自由摄像机如果飞近了只是看到同样的点变大，那 WebGL 白付。所以越近信息越具体：

| 档 | 看到什么 |
|---|---|
| 远景（整棵树） | 4 张盘、节点是点、只有爆炸半径大的带标签。看结构和违规方向 |
| 中景（一张盘） | 该层全部标签浮出，同层内的边显示 |
| 近景（一个文件） | 节点展开成一块牌，上面是**它的导出签名**，周围是它直接依赖的那几块牌 |

最近那一档是关键，而且是**字面**的关键：`ingredientsFor({ graph, files, group: [path] })`
返回的 `IngredientList` 正好是这三样 ——

```
own          [{ path, text }]              中心那块牌：这个文件的完整正文
dependencies [{ path, signatures }]        周围那几块牌：只有签名，没有实现
dependents   string[]                      谁会被它砸到
```

所以飞到一个文件跟前，你看到的**就是 AI 被喂进去的那份配料单本身**，不是打比方 ——
同一个函数、同一个返回值。「认路」和「知情」在这里合成一件事，而不是两个界面。

### 生成类只给一个门

素材/生成类文件按**路径前两段**聚合成一张清单，不进 3D 场景（demo 实测：
按直接父目录聚会出 50 个目录，`assets/scripts/core` 里 28 个 `.meta` 也各占一行；
按前两段聚是 17 扇门，前 8 扇覆盖 95%）：

```
archive/chg001-alternate   87 个
docs/stagepass             79 个
assets/resources           79 个（56 张图 + 18 段音频 + …）
assets/scripts             62 个（全是 .meta —— Cocos 伴生）
docs/history               20 个
verification/fixtures      15 个
…
```

点一条 = 用系统文件管理器打开那个目录，用户自己找。**图谱不做文件浏览器。**
被勾掉的目录（`archive/` 这种）里的**代码**文件也归到这张清单 —— 勾掉 ≠ 消失，
门还在，只是不进场景。

## 集成位置：第三个 view，入口在 Project 行

面板 `.columns` 现在三列：Project 列、Change 列、stage 列
（`#orbit-view` 环 ⇄ `#stage-view` 终端，靠 `.hidden` 互斥切，`panel.js:2490` 一带）。

加 `#graph-view` 做**第三个互斥 view**，入口是 Project 行上一个按钮。四条理由：

1. **图谱是项目级的，不是 Change 级的。** 数据源就是 `projects.path`。
   Change 是项目的子概念，把项目结构挂在 Change 下面是反的。
2. **stage 列是唯一有大空间的地方。** 弹层（`#sheet` 那种）装不下 118 个节点还要能转。
3. **进图谱必须零副作用。** 「看状态不该有副作用」那条 ——「进入终端」顺手起进程
   的教训。图谱是纯读盘 + 纯解析：不写库、不起 pty、不碰 Codex、不记 aside 账。
4. **机制现成。** 互斥切 view 的代码已经在跑，加第三个不需要新架构。

## 架构：三层纯的 + 一层碰盘的

### 纯函数层（可离线证明，不读文件系统）

**`src/graph/code-selection.ts`** —— 判据只在这一处。

```ts
export interface Selection {
  readonly code: readonly string[];
  readonly assetDirs: readonly { dir: string; files: number }[];
}
export function selectCode(
  tracked: readonly string[],
  excluded: readonly string[],
): Selection;
```

判据：

```
是代码  ⇔  后缀 ∈ {.ts,.tsx,.js,.jsx,.mjs,.cjs}
        ∧  不以 .d.ts 结尾
        ∧  路径不在任一 excluded 目录下
```

不是代码的（含被勾掉目录下的代码文件），按**路径前两段**聚合进 `assetDirs`
（根下的散文件归 `(根)` 一扇门）。`tracked` 只来自 `git ls-files` ——
没被跟踪的文件不存在于图谱，所以 `node_modules` / 构建产物天然不用管。

**为什么扩展名白名单而不是读 tsconfig**：demo 的 `tsconfig.json` 写着
`extends: "./temp/tsconfig.cocos.json"`，而 `temp/` 在 `.gitignore` 里 ——
那是 Cocos 生成的、不在版本控制里的文件。**tsconfig 靠不住。**

**`module-graph.ts` 加一个 `cyclesOf(graph)`** —— 不新开文件：它和
`closureOf` / `blastRadiusOf` 是同一类图查询，语义上属于那一层。
用户的项目里**会有**环（这两棵树恰好都没有，但那是运气），图上必须画出来。

**`src/graph/graph-layout.ts`** —— 布局。

```ts
export interface SceneNode {
  readonly path: string;      // 仓库相对路径
  readonly name: string;      // 文件名，去后缀
  readonly layer: number;     // 盘序号，0 = 最底
  readonly x: number; readonly y: number; readonly z: number;
  readonly exports: number;
  readonly deps: number;      // 直接依赖数
  readonly dependents: number;// 直接被依赖数
  readonly blast: number;     // 爆炸半径
  readonly marks: readonly string[];  // 第二阶段用，这一轮恒为空
}
export interface SceneLayer {
  readonly key: string;       // 'assets/scripts/core'
  readonly index: number;
  readonly radius: number;
  readonly z: number;
  readonly count: number;
}
export interface SceneEdge {
  readonly from: number;      // SceneNode 下标
  readonly to: number;
  readonly kind: EdgeKind;    // 复用 module-graph 的
  readonly upward: boolean;   // 违反「只许往下依赖」
}
export interface SceneModel {
  readonly layers: readonly SceneLayer[];
  readonly nodes: readonly SceneNode[];
  readonly edges: readonly SceneEdge[];
  readonly dangling: readonly { from: number; missing: string }[];
  readonly cycles: readonly (readonly number[])[];
  readonly brokenLayerEdges: readonly { from: string; to: string; weight: number }[];
  readonly assetDirs: readonly { dir: string; files: number }[];
  readonly excluded: readonly string[];
}
export function layout(graph: ModuleGraph, selection: Selection): SceneModel;
```

三条布局规则，都是确定性的，所以都能 golden：

1. **组 = 文件的直接父目录。**
   demo → `assets/scripts/core` / `view3d` / `game` / `tests`（4 组）；
   stagepass → `src/domain` … `src`（9 组）。两边都恰好是对的。
2. **层序 = 组图的拓扑序；组图有环时按边权重破，保重的那条。**
   demo 的组图有一个环（`game→view3d` 12 条 vs `view3d→game` 5 条），
   破掉轻的那条得到 `core → view3d → game → tests`。
   **被破的边记进 `brokenLayerEdges` 并在图上标出来** —— 它本身就是一条发现。
3. **盘内位置 = 葵花螺旋，按爆炸半径降序。**
   第 `k` 个节点（`k` 从 0 起）：`r = spacing * sqrt(k + 0.55)`、`a = k * 2.39996`。
   于是盘半径 `R = spacing * sqrt(n)` —— **节点密度在各盘之间自动一致**，
   59 个节点的 `tests` 盘比 14 个节点的 `game` 盘大出 sqrt(59/14) ≈ 2 倍，
   而不是靠一个手调的常数。

**布局放在服务端算是刻意的**：纯函数才有 golden test，坐标不会因为前端
改了个常量悄悄漂。前端只负责画。

### 碰盘层（只有它一个）

**`src/graph/read-workspace.ts`** —— 唯一读文件系统的地方。
跑 `git ls-files`、读正文、串 `selectCode` → `parseModuleGraph` → `layout`。

### 前端（新文件；不往 `panel.js` 里塞，它已经 3241 行）

- **`src/web/graph-scene.js`** —— three.js 场景、CSS2D 标签、raycast、三档 LOD、自由摄像机
- **`src/web/graph-view.js`** —— 可搜索的文件列表、详情牌、勾选目录、素材目录清单

## 四个代价，一条条付

| 代价 | 怎么付 |
|---|---|
| **+600KB 依赖** | `three` 进 `dependencies`，走 ASSETS map 从 `node_modules` 直接喂 —— `panel-server.ts:737` 的 `/xterm.css` 已经是这个套路。零 CDN、零构建步骤；面板是 localhost，不过网络，600KB 等于没成本 |
| **文字模糊** | 节点用 WebGL 画，**标签用 `CSS2DRenderer` 画成真 DOM** —— 真文字，任何缩放下清晰，且标签自己可点 |
| **点击靠 raycast** | raycast 只管 3D 本体。**另有一份真列表**：118 个 `<button>` 带搜索框，管键盘、屏幕阅读器、和「知道文件名想直接跳」。两边共用同一个选中状态 —— 顺手把「每个文件都能点到」做成两条独立的路 |
| **无 WebGL / reduced-motion** | 没有 WebGL 上下文就降级到列表 + 一张平的分层 SVG，不是白屏。**不做自动巡航**，飞行只在拖动时发生 —— reduced-motion 因此天然满足 |

## 路由契约

```
GET /api/graph?project=PRJ-001
  200  SceneModel
  400  { error: 'project-required' }
  404  { error: 'project-unknown' }
  409  { error: 'no-path' }        项目没设 path
  409  { error: 'not-a-repo' }     路径不存在，或不是 git 仓库

GET /api/file?project=PRJ-001&path=assets/scripts/core/GameConfig.ts
  200  IngredientList                ingredientsFor({graph, files, group:[path]}) 原样
  400  { error: 'path-required' }
  403  { error: 'path-outside' }   realpath 逃出项目目录
  404  { error: 'path-untracked' } 不在 git ls-files 里

POST /api/graph-excludes  { project, dirs: string[] }
  200  { excluded: string[] }
  404  { error: 'project-unknown' }
```

## 表变更：一列，走既有迁移

```ts
// schema.ts 的 migrate() 那张清单里加一行
["projects", "graph_excludes", "TEXT"],   // JSON 数组，NULL = 没勾过
```

**顺序陷阱**：`prepareSchema` 是 `migrate()` 先、`SCHEMA_SQL` 后
（`schema.ts:700`）。这一列必须两边都加 —— 只加 `SCHEMA_SQL` 旧库不会长出新列，
只加 `migrate` 新库没有。而**绝不许写引用这一列的索引**：那会让旧库当场打不开。

这一列落在 `migrate()` 自己划的边界内（`schema.ts:723`：「只处理加一个可空列这一种」），
不需要重建表。

## 错误处理：五条，全部 fail-loud

1. **`unresolved` 边要画成断头的边，不许丢。** 这是 `module-graph.ts` 自己写着的
   原则（「一张自称完整的残图比没有图更糟」）—— 而它已经立过功：demo 那 2 条
   就是这么露出来的。
2. **上线前先修 `.mjs`。** `module-graph.ts:92` 的 `resolve()` 无条件补 `.ts`，
   于是 `./tools/cocos-installation.mjs` 解析成 `cocos-installation.mjs.ts` ——
   一个不存在的文件。不修的话，你第一眼看到的就是 2 个**假缺口**。
   改法：已有 `.js/.mjs/.cjs/.jsx/.ts/.tsx` 后缀的不再补。
3. **路径不存在 / 不是 git 仓库** → 明说「这里没有 git 仓库」，不画空图。
4. **非 TS 项目**（Python / Rust）→ 代码节点 0，明说「这个项目里没有能解析的模块」
   并只列目录。**不假装项目是空的。**
5. **无 WebGL** → 降级到列表 + 平的分层 SVG。

## 安全：`/api/file` 是新开的读盘面

两条都 fail-closed：

1. `path` 参数 realpath 之后**必须仍在 `projects.path` 内**
2. 且**必须出现在 `git ls-files` 结果里**（白名单，不是黑名单）

没有这两条，`?path=../../../.ssh/id_rsa` 就通了。第 2 条比第 1 条严 ——
它同时挡掉了符号链接、`.git/` 内部、和任何没被跟踪的文件。

## 测试

| 文件 | 钉什么 |
|---|---|
| `code-selection.test.ts` | 判据。给一份路径清单，离线断言分类 |
| `graph-layout.test.ts` | golden：同输入同坐标；层序拓扑 + 环按权重破；组 = 直接父目录 |
| `module-graph.test.ts` | 两条新的：① `cyclesOf` 在有环图上找到环、无环图返回空；② `./x.mjs` / `./x.js` 不再被补成 `.mjs.ts`（钉「错误处理」第 2 条） |
| `panel-server.test.ts` | 三条路由的全部状态码；`?path=../../etc/passwd` 被拒；未跟踪文件被拒；excludes 存取往返 |
| `schema.test.ts` | 旧库（没有 `graph_excludes` 的）能升上来并且打得开 |

**真机闸门**：面板上点一次 Project 行的图谱按钮 → 看到 118 个节点 4 张盘 →
飞近一个 → 看到它的导出签名。这一步用户亲自点，不是我说通了就算。

## 第二阶段留的位（这一轮不做）

`SceneNode.marks` 这一轮恒为空数组。第二阶段往里填：

- `touched:<changeId>:<phase>` —— 这一轮碰过
- `fed:<changeId>:<phase>` —— 配料单里给过它
- `drift` —— 和架构图对账有差异（`reconcile.ts` 已经能算）

选中一个 Change 时按 marks 着色。**结构上不用改**，所以现在不做绑定不是欠债。

## 明确不做（YAGNI）

- **函数级的节点。** 图谱是文件粒度。函数级依赖是配料单精度的来源，
  但把 302 个导出画成节点，图就废了。
- **图谱变更走对抗 / 图谱有版本。** 2026-08-04 拍过这四条，但那是给
  「AI 按模块写」那条路用的。这一轮是给人看的，不进对抗回路。
- **编辑。** 图谱只读。改代码走 Codex。
- **跨项目对比。** 一次看一个项目。
- **文件浏览器。** 素材目录只给一个门，用系统文件管理器打开。
