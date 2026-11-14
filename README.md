# xiangsu-mcp-plus

[![test](https://github.com/Muqian-Sun/xiangsu-mcp-plus/actions/workflows/test.yml/badge.svg)](https://github.com/Muqian-Sun/xiangsu-mcp-plus/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey) ![node >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)

像塑（Douyin AR，macOS）的 MCP 扩展：**一个 MCP 服务**同时提供像塑官方 MCP 的全部工具，以及官方 MCP 够不到的编辑器能力。

- 官方工具原样转发（`get_scene`、`edit_by_dsl`、`capture_preview`、`save_project` 等），像塑重启后自动重连，官方工具列表变化时通知客户端刷新。官方 MCP 每次调用只回一个完整的 JSON，请求发出后连接断了的调用可能还在编辑器里跑（生成类会扣额度），所以不自动重发，报 `OFFICIAL_MCP_DISCONNECTED`；连不上编辑器（什么都没执行）报 `OFFICIAL_MCP_UNAVAILABLE`。插件和官方调用都不受 Node 自带 `fetch` 的 300 秒响应头超时限制，等多久只看各工具自己的超时。唯一的例外是 `capture_preview`：9.8.1 起官方截图是给窗口里的预览区域拍照，窗口最小化或不可见时是黑的，这时改为重置预览、等到重载后的画面，从预览的渲染结果截取并缩小到官方的 320×569（不含界面元素）；窗口可见时照旧转发，这时刚改完场景或换了预览视频可能还是旧画面（工具说明里写了这一点），要确认新画面用 `preview_frames`。
- 官方素材库：浏览、搜索、看封面、应用（脸部变形、美型、AI 实时变脸、美妆、滤镜、贴纸、画面特效等），流程与素材库面板相同；包括「素材广场」（其他创作者分享的现成 AI 图片、AI 妆容、自定义实时变脸、贴纸和素材包，应用时不重新生成、不扣额度）和自己的「收藏」。
- 「添加对象」菜单：工具栏美妆 / 美型 / AI 实时变脸里的全部官方功能项（美容、面部生成、表情生成、性别年龄、五官处理、身体换装等），可看示意图后按菜单项 ID 添加。
- AI 组合效果（用户拍照后在云端按工作流出图或出视频）：像 AI 效果窗口的「新建工作流」一样建工作流，交给官方工作流工具编辑，再像「应用」一样放进场景。
- 素材库「AI 妆容」：从一张带妆的参考图提取面部、美瞳、眼部、睫毛、唇部五张妆容贴图和推荐强度，看样例脸上的整妆预览，再按部位导入成「面部面具」下的妆容层；提交、记录和建层都驱动面板自己的 `AIMakeupManager`，并补上面板没写进美瞳层的 AI 美瞳贴图和强度。
- 素材库「AI 3D」：图生 3D 模型（一张图 → 静态 GLB 网格）、3D 动画（视频里人的动作 → 套到带标准人形骨骼的 FBX 上）、高精度模型重建（实物环绕视频 → 3D 高斯点云），提交、等待、取消任务，把结果导入工程，请求和导入方式与面板相同。
- 素材库「AR 视频」（AR 视频贴片）：一张主体图或一段主体视频，按动作描述和参考素材生成新动作（或直接抠像），抠好的视频作为 AR 平面贴片放进场景；提交、看抽帧预览、导入、取消都驱动面板自己的 `ARVideoManager`。
- 首页作品：浏览、搜索、看封面，下载完整工程到本地或直接在编辑器里打开（官方工程和已发布的作品），供 agent 读取场景、脚本和资源，学习别人的做法；下载的东西都有登记，用完即删，最长保留 24 小时。
- 交付：设置并上传图标、特效检测（和编辑器里点「特效检测」一样，云端检测）、填好提交窗口（名称、触发提示、摄像头方向、灵感、任务，一直走到「提交审核」页并等检测跑完），确认后勾协议、点「提交审核」送审并读回特效 ID、手机预览二维码、把已领取的任务或创作灵感绑定到工程。
- 抖音音乐：按分类或关键词找歌，设为特效音乐。
- 灵感、任务、排行榜：首页「灵感」页签和活动中心的任务（征集任务、成长任务），以及像塑移动版才有的排行榜（年轻 / 男生 / 女生喜爱榜、每日投稿榜、热玩互动榜、跟拍榜，各榜按两级分类细分；热点榜；专题合集里两百多期主题特效榜和模板榜；创新计划官方精选），用编辑器里登录的账号读取；可收藏灵感、领取任务。
- 看别人的特效、学做法：像塑移动版的全平台搜索（特效、模板、灵感、教程），任意特效的详情（等级、受众、平台判定的类型、用到的编辑器能力、作者）和用它拍的热门视频，排行榜上没分享工程的特效找「做同款」指向的首页工程；官方教程和官方拍摄脚本。
- 运营数据：自己作品的审核状态和驳回原因、精选进度（进没进精选审核、首轮 / 二审 / 结果、按我们历史估的出结果时间）、作品数据和按天趋势、收益、账号和等级、站内信、拍视频激励、从上次告诉用户以来的变化，以及给选方向用的开工简报（从爆款倒推的为什么想玩、AI 写的主攻赛道建议、赛道表、入选样例、失败经验、热点的涨落和扎堆、新灵感和新任务、任务占用）和查题材扎不扎堆，都从运营平台（`xiangsu.muqian.chat`，作品和站内信每 10 分钟、市场数据每天取一次）的只读接口读：`pipeline_*`、`account_status`、`changes_*`、`brief_today`、`track_board`、`pick_samples`、`failure_lessons`、`hot_topics`、`task_usage`。原来直接从编辑器读账号数据的 13 个工具 2026-11-13 下架，旧版看板的 `ops_*` 2026-11-14 下架；插件里对应的取数函数还在，运营平台部署时复用它们。
- 塑型画笔（FaceWarpX）强度：官方能读不能写，这里按检查器滑块的方式改。
- 工程窗口：新建空白工程（首次保存到指定目录）、打开、关闭。本服务开的窗口一律最小化在程序坞里、不抢前台（见下文约定）。
- 干净删除：删除对象时找出只被它使用的资源和它导入时带进来的素材包文件夹，确认后删除。
- 做素材（不用开像塑，原来每个工程各写一遍的脚本）：从预览帧裁图标并压字幕、出列表大小的对比图；按预设合成音效（照各工程音效脚本移植）出 MP3；描边 / 渐变 / 投影文字和圆角、胶囊底板 PNG；把自己的模特照片（或两张照片交替）转成预览视频加进像塑的预览清单；改场景文件里对象的渲染图层和摄像机可见层（DSL 改不了）。文字和图片用 Skia（`@napi-rs/canvas`）渲染，默认用像塑自带的抖音体，音视频用像塑自带的 ffmpeg。
- 9.8.3 素材库「AI 生成」里新增的面板：「画面特效」（描述加参考图 / 视频生成全屏画面特效并导入）和「实时变脸」（一张参考图训练自己的 AI 实时变脸：预览、训练、导入），都驱动面板自己的管理器。
- 图片编辑器的 AI 工具：超清、消除、按描述局部重绘、AI 抠图（主体和头发、身体等部位），不打开窗口。
- 预览输入（官方 `interact_by_dsl` 不收的，走编辑器内置 Agent 的命令）：给预览喂模拟的音量、音高、关键词命中，验声音玩法；预览视频跳到指定时刻、按住拖动、切到某个手势的预览视频。

> 非官方项目，与字节跳动 / 抖音无关。依赖像塑编辑器的内部模块（9.7.2 起实测，当前在 9.8.3 上自检全部通过），像塑升级后可能失效；`ext_status` 会逐项自检并列出缺失的接口。仓库不包含任何像塑的程序、代码或素材。
>
> **只用于学习和个人制作，禁止用来抄袭他人作品**（详见[协议与声明](#协议与声明)）。npm 包名 `@muqian/xiangsu-mcp-plus`。

## 工作方式

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 编辑器插件 `XiangsuMcpExt` | `editor-plugin/` | 像塑用户插件。每个工程窗口里开一个只监听 `127.0.0.1`、带随机令牌的 RPC 服务，调用编辑器自身的模块 |
| MCP 服务 | `src/server.mjs` | stdio MCP。转发官方 MCP（`http://127.0.0.1:17320/mcp`），并把插件能力包装成工具 |

插件把 `{pid, port, token, startedAt}` 写到 `~/.xiangsu-mcp-ext/instances/<pid>.json`（权限 600）。窗口崩溃或被强退时这份记录会留下来，所以只有该 pid 的进程还在、并且启动时间不晚于 `startedAt` 时才算开着的窗口；pid 被后来的进程复用时不算。插件日志在 `~/.xiangsu-mcp-ext/logs/plugin.log`；MCP 服务每次工具调用（名称、耗时、报错、是否发了进度）和异常退出记在 `~/.xiangsu-mcp-ext/logs/server.log`，超过 5 MB 时旧的移到 `server.log.1`；导入记录在 `~/.xiangsu-mcp-ext/imports/`。

按工程找窗口时，同时询问各窗口开着哪个工程，卡住或正在关闭的窗口（5 秒没回应）不影响找到其它窗口，并记住每个工程上次所在的窗口，下次先问它。客户端请求带进度令牌时，工具调用期间每 5 秒发一次进度，避免长调用（连续截帧、等提交页检测）被当成空闲掐断。

## 工具

官方 MCP 的工具按原名提供。扩展工具都接受 `project_path` 或官方的 `instance_id` 指定工程（只开一个工程窗口时可省略）：

| 工具 | 作用 |
| --- | --- |
| `ext_status` | 官方 MCP 连接状态；每个工程窗口的 pid、工程路径、instance_id、有没有未保存的改动、编辑器接口自检 |
| `project_open` / `project_new` / `project_close` | 打开已有工程、新建空白工程并保存到指定目录（窗口都最小化在程序坞里，前台留在原来的应用）、关闭工程窗口（不把首页带出来；有未保存改动时默认拒绝） |
| `image_view` | 看图：列表类工具返回的引用（`cover_ref`、`gif_ref`、任务内容块的 `image_refs` 等，形如 `img:12`）、详情类工具返回的地址（灵感 `images`、菜单示意图）或本机图片路径都放进它的 `images` 数组；视频和音频引用（`video:3`、`audio:5`）返回原地址；一次最多 8 张，动图等大图一次给不完时把没给的列在 `not_returned` 里（单次响应不超过 MCP stdio 的 10 MiB 上限） |
| `library_list` / `library_search` | 官方素材库面板清单（不传 `panel_key`，含素材广场、收藏）和面板里的分页列表、关键词搜索：逐个面板查标题以拿全结果；词正好是面板名或子分类名时也带出那里的素材（「滤镜」「腮红」「复古滤镜」），按标题匹配程度排序，`queries` 一次搜多个词，返回各面板条数和展开了哪些分类，结果缓存 10 分钟供翻页；每条素材带 `kind`、封面 `cover_ref` 和命中方式 `matched`；第一页还附带「添加对象」菜单里同名的项到 `menu_items`（如「脸蛋天才」，用 `menu_add` 加） |
| `library_images` | 一张 AI 图片卡片的整组结果图地址（按 `image_index` 编号） |
| `library_apply` | 下载素材包、校验 MD5、导入并放进场景（可撤销）；素材广场卡片按 `kind` 走编辑器自己的应用流程（AI 图片可用 `image_index` 选第几张）；返回新增对象（素材连带建出渲染组时，组下面这次新加的对象列在 `contents`）和素材包文件夹；素材广场卡片不给 `file_size`（恒为 3409，没有意义） |
| `works_list` / `works_search` | 首页作品分页列表（每页带上全部分类：推荐、官方工程、新手必做、游戏、妆容、AI玩法…；可按推荐 / 最新 / 使用量排序，`next_cursor` 原样传回翻页）、按作品名搜索（默认搜全部分类并合并去重，每条带 `found_in`；`queries` 一次搜多个词；按 `offset` 分页，结果缓存 10 分钟） |
| `works_by_effect` | 按特效 ID 查排行榜等处的特效在首页有没有工程（一次最多 20 个），逐个返回 `found` / `same_style`（移动版「做同款」指向的首页工程，常是别人的另一个特效，`same_style` 给出是哪个）/ `same_name` / `not_on_homepage` |
| `works_download` | 下载并解压完整工程（与首页点开作品同一流程，但不开窗口），返回工程目录和文件概况（`key_files` 只列工程文件、场景和脚本，其余贴图模型只给计数）；`dest` 给定时把工程放到该目录；同一窗口的下载自动排队 |
| `works_open` | 下载并在新窗口里按首页的方式打开（不弹版本升级提示，工程处于未保存状态），返回 pid 和 instance_id |
| `works_cleanup` | 删除下载过的作品（含 `dest`）；编辑器窗口开着的保留，其它路径一律拒绝 |
| `icon_set` / `icon_open` | 把一张图片裁成 360×360 PNG 设为工程图标（默认女性、男性两版，提交窗口要这两个），并像「图标制作」窗口的「完成」一样上传到特效平台（提交窗口只认上传过的图标）；或打开「图标制作」窗口（最小化在程序坞里，由用户点开） |
| `icon_compose` | 从预览帧裁正方形图标（`{top}` 或 `{x, y, size}`，帧自己的像素），可压一行描边 / 渐变 / 投影字幕（太宽时等比缩小），出 720（可设）和 160 两张 PNG，一次最多 4 张；另出列表大小的并排图，后面可接同类作品的图标对比。不用开像塑，满意后交给 `icon_set` |
| `effect_check` | 和工具栏「特效检测」按钮一样：打开特效检测窗口（最小化，不上屏）做云端检测（会上传特效包做测试，不是发布），等待结果，并读出检测页的详情一起返回（页面结论、每项结论、包体积和安卓 / iOS 帧率对上限、没通过的项的改进建议），然后关掉窗口；详情读不出时窗口留着并返回 `details_error`；超时时窗口留着，下次调用先关掉它 |
| `submit_prepare` | 本地检查包体上限、是否原样套用模板、登录、图标，通过后先关掉还开着的提交窗口（之前调用留下的），再走「提交特效」按钮的入口打开一个新的（最小化在程序坞里），逐页填写：名称（必填）、触发提示、默认摄像头方向、灵感、任务和赛道（可用 `icon_image` 先设图标），翻到「提交审核」页并等页面检测跑完，返回摘要、检测结果、协议是否已同意和 `next`（你还要做什么）。每一项都从页面读回核对，页面截断、报错、没选上或翻页被拦时报 `SUBMIT_*` 错误，窗口保持打开。不勾协议，也不点「提交审核」，不会送审 |
| `submit_confirm` | 送审：在 `submit_prepare` 留下的那个提交窗口里勾上《创作者协议》（账号已同意过时不用勾），点「提交审核」，特效真正提交审核、占用提交次数。`name` 须和窗口摘要一致；页面检测没跑完或没通过时不点；账号最新的 10 个作品里已有同名、在审核中或审核过了的也不点（`SUBMIT_ALREADY_SUBMITTED`），防止重复提交。点了之后等页面报结果（最多 5 分钟）：成功返回 `effect_id`、是否替你勾了协议、是否提示实名认证，关掉窗口，并到账号最新的作品列表里找到这条特效放在 `listed`。页面没确认成功（报失败、停止提交却没给结果、没等到结果）时先到作品列表里找这条，找到就照成功返回、页面当时的情况放在 `page_problem`；找不到才报 `SUBMIT_FAILED`（页面给了失败原因）或 `SUBMIT_RESULT_UNKNOWN`，不自动重试，重交前先 `pipeline_refresh` 再看 `pipeline_works` |
| `submit_close` | 关掉开着的提交窗口，不打开新的 |
| `mobile_preview` | 按手机预览方式打包上传到抖音预览服务，返回和编辑器一样的二维码（7 天有效），抖音 App 扫码真机看；二维码同时存成文件（`~/.xiangsu-mcp-ext/mobile-qr/`），到期自动删除 |
| `inspiration_list` / `inspiration_detail` | 灵感分页列表（每页带上全部分类，每条带关联热点）、详情（说明、图片、奖励、关联热点的热度和标签、同灵感特效、示例视频的播放地址和封面、贴纸、是否已收藏）；关联工程服务端只给标题，没有 id，要下载就拿标题去 `works_search` |
| `inspiration_collect` | 收藏或取消收藏灵感（写账号），之后重新查询确认生效 |
| `inspiration_collected` | 当前账号收藏的灵感（按收藏时间从新到旧分页），字段同 `inspiration_list`，另有收藏时间、作品类型和所属征集任务；`submit_prepare` 的 `inspiration` 就在这些收藏里选 |
| `inspiration_bind` | 把灵感绑定到当前工程，提交时带上；提交窗口只列已收藏的灵感，没收藏的会顺手收藏 |
| `tasks_list` / `task_detail` | 活动中心的活动和特效征集任务的列表（按 `offset` / `count` 分页）与征集任务详情（状态和状态说明、奖励、整理过的任务说明：每个内容块的条目、参考图和视频引用、奖项金额和名额、链接，`save_to` 另存原始返回；征集任务详情还有自己提交到这个任务的特效 `my_effects`：审核状态、拍摄 / 播放 / 投稿峰值、获奖金额、任务评定 `task_state`（`pending` / `unfinished` / `done`）和是否被标「主题不符合」`off_theme`） |
| `growth_tasks_list` / `growth_task_detail` | 活动中心的成长任务列表（奖励、参考工程，分页）与详情（参考工程、相关灵感、教程） |
| `task_receive` | 领取一个待领取（`WAIT_RECEIVE`）的征集任务（写账号，不能撤销），其它状态直接拒绝；领完自动重读任务列表，接着就能 `task_bind` |
| `task_bind` | 已领取的任务按任务详情页「去创作」的方式重开工程绑定；这个工程是唯一的窗口时，先开一个不保存的空工程当跳板，绑完关掉 |
| `rank_list` | 分页读移动版排行榜（榜单和筛选项写在参数说明里），可按日期、每级一个分类、特效等级、面板、偏好、来自工具、年轻喜爱度过滤；每页带上该榜当天的两级分类（大类如人像美化、细类如美妆） |
| `rank_hotspots` | 热点榜（按 `offset` / `count` 分页） |
| `hotspot_inspirations` | 一个热点下的灵感，按热点页页签的顺序分页，每条标出页签 |
| `hotspot_inspiration_images` | 把一个热点下全部灵感详情里的图片下载到临时目录（24 小时后删除），文件名带序号和灵感标题，另写 `index.json` 记下每张图属于哪条灵感；6 条并发，单张 30 秒超时、失败重试一次，失败的灵感列在 `failed` |
| `rank_subjects` | 专题合集里按主题的特效榜（`kind=effect`，如「热爆美妆特效榜」「熊出没IP特效榜」）和模板榜（`kind=template`，如「歌词玩法模板榜」），按 `cursor` 分页 |
| `rank_subjects_search` | 按榜名在专题合集全部期里搜索 |
| `rank_subject_detail` | 一个专题榜的全部特效 |
| `rank_innovation` | 创新计划官方精选（`kind=template` / `effect`）；同页重复的特效合成一条、标签合并，服务端翻页会出现上一页的特效 |
| `pipeline_works` | 运营平台（`xiangsu.muqian.chat`）：全部作品走到精选的哪一步，分上线、精选、精选奖三条线和要处理 / 等结果 / 已结束三组，驳回和落选原因原文，按我们历史估的出结果时间，任务和灵感评定，曝光 / 投稿 / 收益；账号限制、提交节奏、各块数据的健康 |
| `pipeline_work` | 运营平台：一个作品的时间线、按天趋势、数据卡片、能力、流量标签、审核记录、收益、用户视频和全部变化 |
| `brief_today` | 运营平台：开工简报，会话开始读一次——账号能不能交、新变化、从爆款倒推的为什么想玩和 AI 按选题流程写的今天主攻方向（倒推自哪几个爆款、借哪个热点、候选绑定和要对上的要求，推断）、赛道表、从我们结果算出的规律、失败经验、热点、新灵感和新任务、任务占用 |
| `hit_reasons` | 运营平台：年轻喜爱、每日投稿、热玩互动、跟拍榜前 20 和最近入选的精选，每个带用户视频标题、点赞、封面和 AI 归纳的为什么想玩（推断） |
| `track_board` | 运营平台：全部赛道（细分类型）平台近 30 天 / 7 天精选数，我们做了几个、进审、入选、落选、进审率，最近入选的样例和用到的能力 |
| `pick_samples` | 运营平台：官方精选作品明细，按赛道、类型、最近几天筛 |
| `failure_lessons` | 运营平台：全部失败经验（驳回、测试未通过、精选落选、首轮没过、没进审），每条带平台原话、次数、涉及作品 |
| `hot_topics` | 运营平台：像塑热点，和一天前比的涨落、站内同题材几个、扎堆还是还早，和每个热点下的灵感（只有像塑自己的热点，不含站外热榜） |
| `inspirations_new` | 运营平台：新出现的灵感和现在挂着的【创新】灵感，带玩法说明、激励截止和要同时绑的任务、奖励和前 3 张参考图 |
| `tasks_open` | 运营平台：活动中心没截止的全部任务，发布、截止、领没领、同类型条款、要对上的要求原文、我们放了哪些作品 |
| `task_requirements` | 运营平台：一个任务的全部说明原文（任务说明、参与要求、奖项详情、灵感玩法），不用开编辑器 |
| `topic_crowd` | 运营平台：查一个题材词在站内有几个同题材的特效和模板（平台去搜，工具最多等 60 秒） |
| `task_usage` | 运营平台：我们绑过、还没截止的任务，每个作品的平台分类和评定，有没有同类型条款 |
| `account_status` | 运营平台：账号限制和解除时间、提交节奏、像塑登录态、资料和数字、收入、等级成长、拍视频激励、精选作者计划、最近 50 条站内信 |
| `changes_since` | 运营平台：从「已经告诉过用户」的进度往后的变化（阶段、评定、通知、账号限制、登录态），带一句话和要不要用户动手 |
| `changes_ack` | 运营平台：告诉完用户后把进度推到 `changes_since` 返回的 `up_to`，所有 agent 对话共用 |
| `pipeline_refresh` | 运营平台：现在重取一次作品列表、站内信和到点的数据卡片，5 分钟最多一次 |
| `effect_detail` | 任意已上线特效或模板的详情（按 `app_effect_id`，别人的也行）：等级代码、累计投稿 / 点赞 / 评论、喜爱度、男女比例、受众、风格、平台判定的类型、来自哪个工具、流量状态、用到的编辑器能力 `functions`、作者及等级、几条示例视频（图标和视频给短引用） |
| `effect_videos` | 用一个特效拍的热门抖音视频（标题、作者、点赞、跟拍、抖音视频 ID、封面和视频引用）和累计点赞、跟拍 |
| `effect_search` | 移动版搜索：按关键词搜全平台已上线的特效（最多 100 条）或模板（`kind`），按 `cursor` 翻页，每页最多 20；顺序是服务端定的（偏向累计投稿高的老特效），接口不认排序参数 |
| `inspiration_search` / `tutorial_search` | 移动版搜索：按关键词搜灵感、官方教程（字段同 `inspiration_list`、`tutorials_list`） |
| `tutorials_list` | 官方教程：全部分类（特效、模板两组）和一个分类或全部教程（标签、学习人数、飞书文档链接（要登录，读不到正文）、视频引用），按 `offset` 分页 |
| `shoot_scripts` | 官方拍摄脚本（教你用特效拍什么视频，带完整做法、播放数和拍摄数、示范视频引用），按标签代码筛选、按 `offset` 分页 |
| `music_categories` | 抖音音乐库的分类 |
| `music_list` / `music_search` | 一个分类的歌、按关键词搜歌（带版权标记），按 `cursor` 翻页 |
| `music_apply` | 按音乐库「使用」套用一首歌，可截取片段 |
| `scene_tree` | 场景结构的缩进文本：渲染组、对象 guid、名称、是否隐藏、组件类型；可只看子树（按 guid、名称或层级路径找，重名时列出候选）、控制层数。传 `project_dir` 时不开窗口，直接读工程的 `Assets/main.scene`（如 `works_download` 下载的作品），对象写成 `#序号` |
| `inspect_many` | 一次查看多个对象（guid、名称或层级路径）的组件参数，可按组件类型、属性名片段过滤，`{type, data}` 包装直接展开，绑定的资源和对象换成名称，妆容层的混合模式编号旁边写上名称；`preset="key"` 只留关键参数（变换、显隐、强度/不透明度/Transparency/颜色类、AI 脸 Channel、内部含强度类参数的整块参数如后处理发光、文字内容、绑定、脚本参数），并丢掉空贴图槽和完全透明的黑色。同样支持 `project_dir` |
| `makeup_layers` | 读工程目录里的全部美妆层（妆容层、旧版 `FaceMaskDY` 妆容层和美瞳），逐层给出区域、部位、混合模式、平均色、着色、贴图色乘着色的 `tinted_color`（没有实测核对）、男女强度和实际生效的不透明度（单独加的层：面板不透明度 × 男女强度 × 外部强度；整套美妆子项由 AI 脸接管，只按男女强度 × 外部强度）、表面质地（水润、珠光等）、只作用于哪几张脸、是否生效；部位先看层名，看不出时按贴图像素和混合模式判断（滤色等只会提亮的层归为高光）；整张不透明的贴图按离「不改变皮肤」的颜色多远算颜色和范围。`texture_source` 标出贴图是 AI 妆容提取的（带 `task_id` 和部位）、素材广场 AI 妆容卡片的、官方素材包（带 `package_id`）、作者导入还是副本。`sets` 列出整套妆（AI 实时变脸）各管哪些层，这些层带 `in_set`：删掉或关掉其中一个整套都会消失，只能把强度调成 0。`groups` 按底妆、眉、眼妆、美瞳、颊、轮廓、唇汇总，`absent` 列出整套妆没有的部位 |
| `makeup_compare` | 在同一张脸上比较几种妆容状态（关掉某层、男女强度、面板不透明度，或任意组件的数值属性如 AI 脸 Transparency、发光强度）：重置预览后截基线、逐个实时套上改动截图并改回、最后再截一次基线核对画面没变。要用静态照片做的模特视频；区域按画面比例给。可传 `reference` 参考图，区域带 `ref` 框时每种状态另给相对参考的差值，并排图末格是参考。每个区域返回平均色、亮度、皮肤细节及差值，并排放大图（不插值，一行放不下时换行） |
| `preview_frames` | 按间隔连续截取预览，720×1280 原始分辨率（官方截图是 320×569），取自渲染结果，窗口在后台或最小化时也能截；默认先重置预览并等到重载后的画面再计时，截图期间临时恢复正常帧率（后台窗口平时 6 fps）；可依次换几个预览视频各截一组、截完切回（等编辑器把视频写回工程，原来干净的工程截完仍是干净的），可按比例裁出局部；每帧存成文件并返回，默认 24 小时后删除。这些截图 / 对比工具都可传 `save_to` 把结果另存到目录长期保留 |
| `preview_videos` | 预览视频名，按 `tracking_type` 分组，外加当前视频；只给名字，挑 `preview_frames`、`makeup_compare` 的 `videos` 用（官方 `list_preview_videos` 约 70 KB） |
| `menu_list` / `menu_add` | 「添加对象」菜单项列表（`total` 是命中数，`menu_total` 是菜单总数；`details=true` 时带说明和示意图，一次最多 8 项）、按菜单项添加（可撤销）；云端 AI 生成项不暴露（AI 组合效果用下面两个工具） |
| `ai_combine_new` | 新建一张「AI 组合效果」工作流，等同 AI 效果窗口的「新建工作流」：本地建 AI Graph，只有「输入图」「效果组合」两个节点且未连线，不联网、不扣额度、不建云端草稿；返回 `ai_graph_id` 和各节点的 `node_id`（与官方 `get_workflow_context` 的节点 ID 相同） |
| `ai_combine_apply` | 把一张 AI 工作流放进场景，等同「应用」（可撤销）：编辑器编译工作流、上传工作流文件，再添加「AI 组合效果」对象（没有 2D 前景时一并建「2D 前景」「2D 摄像机」）；不扣额度、不建草稿，生成过预览视频时一并上传供审核；编辑器拒绝时返回它的提示原文（如「请先连接效果组合器」）；返回新增对象和 `draft_id` |
| `ai_video_node` | 在 AI 工作流里加或改一个「视频生成」节点，即 AI 效果窗口的「图生视频」（Seedance 2.0 Mini / Fast / 2.0 / 2.5 等），官方 `apply_workflow_patch` 只能建生图节点。新建时照节点编辑面板的做法用所选模型（默认 Seedance 2.0 Mini）初始化，连好「输入图 → 视频生成 → 效果组合」并摆在两者之间；传 `node_id` 时改已有节点，换模型时提示词沿用。提示词、时长、比例、分辨率按所选模型的面板核对（各模型范围不同，不合法时列出可选值）。改完存成云端草稿（同官方补丁），不扣额度 |
| `ai_video_results` | 读 AI 工作流里「视频生成」和「效果组合」节点的生成结果（官方 `generate_workflow` 成功后；官方 `download_workflow_node_asset` 只认生图节点）：节点状态和每段视频的本机文件（AI 效果窗口预览用的缓存，没有下载水印）、宽高、时长 |
| `ai_makeup_submit` | 素材库「AI 妆容」的「立即提取」：上传带妆人像（PNG/JPG/JPEG，不超过 10 MB），默认等到提取完（最多 `wait_s`，默认 60 秒，实测每次 5–8 秒），返回 `task_id`、五个部位的贴图 `image_ref` 和推荐强度（面板不透明度、男女强度、混合模式及名称）、参考原图和整妆预览 `preview_file`（妆画在编辑器内置样例脸上）；有任务在跑时拒绝 |
| `ai_makeup_tasks` | 分页列出 AI 妆容提取记录（与面板同一份，最新的在前，每页最多 20 条）；带 `task_id` 时只查一个并给整妆预览，再给 `wait_s` 就等到它不再运行（最多 300 秒） |
| `ai_makeup_import` | 把一个完成的提取按部位（`parts`，默认全部）导入工程：贴图按面板的文件名进 `Assets`（同名时编辑器自动加「 (1)」，不覆盖之前的），在「面部面具」下建层并套推荐强度（可撤销）；美瞳层另外写上 AI 美瞳贴图和强度（面板在 9.8.1 写不进去）；返回每层的 `object_path`、贴图和读回的强度 |
| `ai3d_image_submit` | 素材库「AI 3D › 3D模型」：上传参考图（PNG/JPG/JPEG，不超过 10 MB、4000 像素），按精度（low / medium / high = 1000 / 10000 / 50000 面）提交图生 3D，返回 `task_id`；产物是静态网格，没有骨骼 |
| `ai3d_animation_submit` | 「AI 3D › 3D动画」：上传参考视频（MP4，不超过 30 秒、20 MB、1280 像素）和模型（内置 `whole` / `upper_body` / `lower_body` / `arm`，或本地 FBX），提交动作生成；本地 FBX 按面板的方式检查骨骼（缺标准人形骨骼只提醒，与编辑器一致）和导入上限 |
| `ai3d_gs_segment` / `ai3d_gs_submit` | 「AI 3D › 高精度模型重建」两步：上传环绕视频（MP4/MOV，不超过 120 秒、100 MB、4000 像素）识别主体，返回主体图 `subject_image_ref`；确认后按主体生成 3D 高斯点云 |
| `ai3d_tasks` | 按类型分页列出 AI 3D 历史任务（状态、时间、输入、失败原因、本机是否已下载和预览文件），每页最多 20 条；带 `task_id` 时只查一个（不用给 `kind`），再给 `wait_s` 就等到它不再运行（最多 600 秒） |
| `ai3d_import` | 下载并解压一个已完成任务的结果（放在编辑器的 AI 3D 缓存目录，面板里同样能看到），导入工程并放进场景（可撤销），与面板的「导入素材」相同 |
| `ai3d_cancel` | 取消运行中的 AI 3D 任务 |
| `ar_video_submit` | 素材库「AR 视频」的「立即生成」：`mode=direct` 主体视频只抠像，`mode=motion` 按 `prompt`（必填）和参考图 / 参考动作视频生成新动作；`shadow`（添加投影）、`duration_s`（4 秒到编辑器开关给的上限）。输入先过编辑器自己的检查、转换和视频审核，云端接受后返回 `task_id`，任务转到工具栏的后台任务里 |
| `ar_video_tasks` | 列出 AR 视频生成记录（最新的在前，带当前限制 `limits`）；带 `task_id` 时只查一个，再给 `wait_s` 就等到结果在本机合成完（最多 600 秒）。完成的带预览视频、要导入的视频和一张横排 6 帧的预览图 `preview_image_file` |
| `ar_video_import` | 把一个完成的任务导入工程并放进场景，等同面板「导入素材」，只导这一个；返回新增对象和 `plane_guid` |
| `ar_video_cancel` | 取消运行中的 AR 视频任务 |
| `ai_vfx_submit` | 素材库「AI 生成 › 画面特效」（9.8.3 新增）：描述加最多 10 张参考图、1 段参考视频，生成 1–10 秒全屏画面特效，返回 `task_id`；参考视频先过编辑器的上传审核 |
| `ai_vfx_tasks` | 画面特效的生成记录（带当前限制）；带 `task_id` 时只查一个，再给 `wait_s` 就等它不再生成中。完成的带本机预览视频和横排 6 帧预览图 |
| `ai_vfx_import` / `ai_vfx_cancel` | 把完成的画面特效导入工程（编辑器转成表面图和材质）、取消生成中的任务 |
| `custom_gan_styles` | 素材库「AI 生成 › 实时变脸」的风格（全身换装、真人搞怪、表情迁移、真人美化）、各自的流程和今天剩余的训练次数 |
| `custom_gan_submit` | 实时变脸第一步：一张参考图生成样例男女脸上的预览（不消耗训练次数），面板同时只允许一个预览在生成 |
| `custom_gan_tasks` | 实时变脸的任务：预览图、真人搞怪的候选图、训练状态和预览视频；带 `task_id` 时可等 |
| `custom_gan_train` | 训练（消耗 1 次当天的训练次数，3–12 小时）；真人搞怪先生成候选图，再挑满 30 张训练，和面板一样 |
| `custom_gan_import` | 下载训练好的模型和预览视频，按 AI 实时变脸素材导入并放进场景（可撤销） |
| `image_upscale` / `image_repaint` / `image_matting` | 图片编辑器的超清、消除 / 局部重绘（用遮罩图或矩形标区域，按编辑器的方式涂成绿色棋盘格再提交；给 `prompt` 是重绘）、AI 抠图（主体和头发、身体等部位），结果存成 PNG 并附预览 |
| `preview_audio_test` | 给预览喂模拟声音验声音玩法：开启编辑器内置 Agent 的试玩会话（预览重载一次，注入把模拟输入转成 AudioDetection 结果的运行时），按步骤喂音量 / 音高 / 关键词命中或未命中并截图，最后关会话（再重载一次）。脚本读到的值用官方 `get_script_logs` 看 |
| `preview_actions` | 官方 `interact_by_dsl` 不收的预览命令：`touch_move`、`seek_to_time`、`switch_gesture_video`（换成编辑器给某个手势配好的预览视频） |
| `sfx_synth` | 按预设合成音效（ding、tick、pop、boing、puff、win、chime、whoosh、wahwah、lose、reveal、sparkle、heartbeat、shutter、miss、hit、stamp、shiver 共 18 种，频率、包络、音量照各工程的音效脚本，没有随机噪声的和原脚本逐采样一致），可升降调、调音量，出双声道 128 kbps MP3 或 WAV。不用开像塑 |
| `ui_text_image` / `ui_panel` | 描边 / 渐变 / 投影文字 PNG（Text2D 设不了描边），圆角或胶囊底板 PNG（可带几行文字），一次一批，返回每张的宽高。不用开像塑 |
| `preview_model_add` | 把模特照片（或视频、或两张照片交替循环）按内置预览视频的规格转码，加进像塑的预览清单 `PreviewResources.json`（先备份）；新开的工程窗口就能在 `set_preview_video` / `preview_frames` 里用 |
| `scene_set_layer` | 改已保存工程 `Assets/main.scene` 里对象的渲染图层和摄像机的可见层（DSL 改不了）：只改那几行，改完解析核对，工程窗口开着时拒绝，先备份 |
| `face_warp_list` / `face_warp_set_intensity` | 列出塑型画笔、改强度（保留笔刷数据，可撤销） |
| `object_remove` | 删除对象（可撤销），报告只被它使用的资源和它导入时带来的素材包文件夹；`delete_unused_resources=true` 时一并删除 |
| `resource_delete_unused` | 删除 `object_remove` 报告的路径；场景仍在引用的一律拒绝 |

使用顺序示例：

- 套用官方素材：`library_search` → `image_view` 看 `cover_ref` → `library_apply` → `capture_preview` → `save_project`。
- 读别人的工程：`works_search`（或 `works_list`）→ `image_view` 看 `cover_ref` / `gif_ref` → `works_download` → 按返回的 `outline.key_files` 读 `effect.dyehpj`、`Assets/` 下的场景和 `Graph/` 下的脚本 → `works_cleanup`。
- 在编辑器里看别人的效果：`works_open` → `get_scene` / `capture_preview` → `project_close`（`discard_changes=true`）→ `works_cleanup`。
- 交付：`icon_set` → `effect_check` → `mobile_preview` 真机看 → `save_project` → `submit_prepare`（`name`、`trigger_hint` 等），检查返回的摘要和 `next`，和用户确认后 `submit_confirm`（同一个 `name`）送审，看返回的 `effect_id` 和 `listed`。要参加任务的，`tasks_list` → `task_receive` → `task_bind`，或者直接在 `submit_prepare` 里传 `task`。
- 出方向：先 `hit_reasons` 看头部做的是什么、用户怎么拍、为什么想玩（封面交给 `image_view`）→ 带着这些找热点：`hot_topics` 看像塑热点的涨落和扎堆，`topic_crowd` 查候选题材在站内扎不扎堆 → `track_board`、`pick_samples` 对照精选 → 绑任务和灵感：`tasks_open` 的 `requirements`（全文 `task_requirements`）和 `inspirations_new` 的 `detail` 逐条对上要求才绑。
- 找选题：`rank_list`（如 `rank_type=1` 年轻喜爱榜、`categories=["人像美化","美妆"]`、`levels=["S","A+"]`）看什么在火；`rank_subjects_search`（`keyword="测一测"`）或 `rank_subjects`（`kind="template"`）看各期主题榜，`rank_subject_detail` 看一个榜的全部特效；`rank_hotspots` → `hotspot_inspirations` 看热点灵感 → `inspiration_detail` → `image_view` 看图；`tasks_list` → `task_detail` 看征集要求和奖项 → `image_view` 看内容块里的参考图。
- 看榜上特效的工程：`rank_list` → 把这页的 `effect_id` 和 `name` 交给 `works_by_effect` → `status=found` 或 `same_style` 的用返回的 `template_id` 走 `works_download` / `works_open`（`same_style` 下载到的是 `same_style` 里那个特效的工程，不是榜上这个特效本身的）。
- 拆别人的爆款：`rank_list` 或 `effect_search`（如「美妆」）→ `effect_detail` 看受众、平台判定的类型和用了哪些编辑器能力 → `effect_videos` 看别人怎么拍、标题怎么写（`image_view` 拿视频地址）→ `works_by_effect` 找能下载的工程。
- 学做法：`tutorials_list` 看官方教程分类，或 `tutorial_search` 按关键词找；拍视频推作品用 `account_status` 的 `shoot_activity` 看本期激励任务，`shoot_scripts` 看官方拍摄脚本。
- 查审核和精选：`pipeline_works` 看每个作品到了哪一步（被驳回的在 `online.reason` 里写着原因），刚提交、刚上线时先 `pipeline_refresh`；一个作品的时间线、审核记录原文用 `pipeline_work`；会话开始用 `changes_since` 看新变化，告诉完用户再 `changes_ack`；被驳回的在编辑器「拍摄特效管理」里点「编辑」改完重新提交。
- 看作品表现和账号：`pipeline_work` 看一个作品的数据卡片、按天趋势、收益和用户视频；`account_status` 看账号、收入、等级和站内信；会话开始和出方向前 `brief_today`，细看用 `hit_reasons`、`track_board`、`pick_samples`、`failure_lessons`、`hot_topics`、`inspirations_new`、`tasks_open`、`task_requirements`、`task_usage`；提交前看 `account_status` 的限制和提交节奏。
- 拆别人的妆：`works_download` → `makeup_layers` 看用了哪些部位、什么颜色、多浓；自己的工程 `save_project` 后同样用 `makeup_layers` 查缺了哪些部位。
- 复刻妆面：`ai_makeup_submit`（参考图）→ `image_view` 看 `preview_file` 和参考原图 → `ai_makeup_import`（可只导部分部位）→ `library_search` / `library_apply` 用官方单品补 AI 妆容没给到的部位、套 AI 脸和滤镜 → `makeup_compare`（可对参考图）调强度、`preview_frames` 验收 → `save_project`。
- 调强度：`makeup_compare` 在同一张脸上比「关掉这层」「0.3 / 0.6」、面板不透明度、AI 脸 Transparency 等，看眼下、脸颊等区域的亮度和颜色变了多少。
- 做 3D 角色：官方 `generate_image`（正面全身、纯色背景）→ `ai3d_image_submit` → `ai3d_tasks`（`task_id` + `wait_s`）→ `ai3d_import` → `capture_preview` 调大小和位置 → `save_project`。图生 3D 的模型没有骨骼，动作用脚本驱动；要用视频里的动作，模型须带标准人形骨骼（如 Mixamo 绑过骨、去掉 `mixamorig_` 前缀），走 `ai3d_animation_submit`。
- 做图标：`preview_frames`（`save_to`）截出效果最明显的帧 → `icon_compose`（女生图、男生图各一张，压一句说明玩法的字幕，`compare_images` 放同类作品的图标）→ 看并排图 → `icon_set`。
- 做界面和音效：`ui_text_image`（弹字、数字）、`ui_panel`（提示条、结算卡），`out_dir` 指到工程的 `Assets/UI/`；`sfx_synth` 出到 `Assets/Sfx/`，再用官方 `list_resources` 看有没有自动导入，没有就 `import_resource`。
- 验声音玩法：脚本里用 `AudioDetectionModule` 的音量或关键词检测 → `preview_audio_test`（如音量 0.12 持续 2 秒、关键词命中「芝麻开门」）→ 看截图和官方 `get_script_logs`。
- 加自己的预览模特：`preview_model_add`（照片，或平静照 + 表情照交替）→ 关掉工程窗口重开 → `preview_videos` 里就有它。
- 只给某个摄像机画的对象（擦痕遮罩画进渲染纹理）：建好对象 → `save_project` → `project_close` → `scene_set_layer`（对象设到图层 1、摄像机只看图层 1）→ `project_open`。
- 做画面特效：`ai_vfx_submit`（描述加参考图）→ `ai_vfx_tasks`（`task_id` + `wait_s`）→ `image_view` 看 `preview_image_file` → `ai_vfx_import` → `preview_frames` → `save_project`。
- 训练自己的 AI 实时变脸：`custom_gan_styles` 看风格和次数 → `custom_gan_submit` → `custom_gan_tasks` 看预览图 → 和用户确认后 `custom_gan_train`（真人搞怪先出候选图再挑 30 张）→ 几小时后 `custom_gan_tasks` 看到训练完成 → `custom_gan_import`。
- 做 AR 视频贴片：官方 `generate_image`（主体正面全身、纯色背景）→ `ar_video_submit`（`mode=motion`、`prompt`）→ `ar_video_tasks`（`task_id` + `wait_s`）→ `image_view` 看 `preview_image_file` → 满意再 `ar_video_import` → `capture_preview` → `save_project`。
- 做 AI 组合效果：`ai_combine_new` → 官方 `get_workflow_capabilities`（选生图基模）→ `apply_workflow_patch`（加生图节点、写 prompt、连「输入图 → 生图 → 效果组合」）→ 要看效果时官方 `generate_workflow`（扣额度）→ `ai_combine_apply` → `save_project`。做图生视频时把中间两步换成 `ai_video_node`（写提示词、时长等，连线它自己做），再用官方 `upload_workflow_image` + `apply_workflow_patch`（`update_node_params`）给输入图绑照片，之后同上。别人的作品怎么搭的，用 `works_download` 下载「AI玩法」分类里的工程，看 `Assets/AI 组合效果/*.oAICombineTextureJSA` 里的 `workflow` 和 `Graph/graph.json` 里的 AI Graph。

相近工具的分工（每个工具只做一件事，这些也写进了工具说明；和官方工具重叠的，在官方工具的说明末尾补了一句指向这里）。判据：一个参数会让工具换成另一种查询或操作（列表和详情、榜单和搜索、两张不同的页面卡片），就拆成两个工具；只是缩小范围的筛选（分类、分页、排序）留作参数。

- 看场景：`scene_tree` 先摸清结构（紧凑文本，也能读下载的工程目录）→ `inspect_many` 一次看多个对象的参数；要完整 JSON 才用官方 `get_scene` / `inspect`。
- 删对象：只删对象用官方 `edit_by_dsl`；要知道删完哪些资源没人用了、连带清理，用 `object_remove`（→ `resource_delete_unused`）。
- 绑灵感：`inspiration_bind` 按 ID 写进工程，提交窗口自动带出；只在提交时选，给 `submit_prepare` 传 `inspiration`（在收藏的灵感和热点里按名称选）。
- 绑任务：`task_bind` 重开窗口把任务写进工程；只在提交时选，给 `submit_prepare` 传 `task`，不用重开窗口。
- 成长：`growth_tasks_list` 是活动中心里一个个成长任务（参考工程、教程），详情用 `growth_task_detail`；特效师等级和每级目标进度看 `account_status` 的 `growth`。
- 素材库：知道要找什么用 `library_search`；按面板和子分类浏览用 `library_list`。
- 搜特效：要能下载的工程用 `works_search`（只搜首页作品）；要看全平台已上线特效的数据用 `effect_search`，再用 `works_by_effect` 找工程。灵感按分类翻用 `inspiration_list`，按关键词搜用 `inspiration_search`；教程同理（`tutorials_list` / `tutorial_search`）。

几点约定：

- `library_apply` / `library_images` 只接受本会话里 `library_list` / `library_search` 返回过的 `template_id`；`works_download` / `works_open` 只接受本会话里 `works_list` / `works_search` / `works_by_effect` 返回过的作品（记录在 MCP 服务里，不受工程窗口开关影响，重启服务后需重新搜索）。
- 像塑最多同时开 2 个工程窗口（编辑器的 `CHILD_PROCESS_LIMIT`）。都占满时 `project_open` / `project_new` / `works_open` 返回 `WINDOW_LIMIT`（首页进程答复 `reuseCurrent`，工具不会把工程换进当前窗口），先 `project_close` 一个。刚 `project_close` 完名额要过几秒才释放，开窗遇到 `WINDOW_LIMIT` 会每秒重试、最多 8 秒；仍失败时报错列出占着名额的窗口。`works_open` 在下载之前先查名额，满了直接拒绝。
- 像塑不上屏、不抢前台：本服务做的任何事都不把像塑带到前台。9.8.1 / 9.8.3 实测窗口进程第一次显示一个窗口、以及接手一个工程时（还没有窗口上屏）都会把自己切到前台，加载完工程后编辑器还会聚焦编辑窗口并激活应用。所以：开工程窗口（`project_open`、`project_new`、`works_open`、`task_bind`）前，MCP 服务在状态目录 `quiet-open/` 下给这个工程（新建工程用一个「新建」标记）写一个标记，接手它的窗口进程里，插件看到标记后，加载进度窗不上屏，编辑窗口和之后出现的窗口都最小化显示（没有最小化按钮的窗口先补上按钮，否则它不进程序坞），聚焦、置顶、激活一律跳过；`icon_open`、`effect_check`、`submit_prepare` 打开的窗口在任何窗口进程里同样处理（检测和提交页面在最小化时照常运行）。用户从程序坞点开编辑窗口后，这个进程就照编辑器原样行事。接手工程那一下的激活拦不住，这些工具运行期间 MCP 服务每 0.1 秒查一次前台，像塑一抢到就交还给最近一个在前台的其它应用（`open -b`，不需要辅助功能权限）；`project_close` 不再让首页窗口出来，关窗后首页补起的空闲窗口进程也会抢前台（实测有一次一直不还），所以关窗后在后台继续盯到它起来。实测每次被抢 70–450 ms，屏幕上不出现像塑窗口；像塑本来就在前台（用户正在用）时不盯。窗口没按最小化出现时报 `WINDOW_IN_FRONT`（工程已经开着）：多半是接手它的窗口进程在插件更新之前就已启动，关掉它或重启像塑。最小化的窗口不绘制场景视图（挪到屏幕外显示也不行，macOS 会把它的一角留在屏幕上，拍到的仍是一片纯色），所以这时 `get_scene_view` 拒绝调用（`SCENE_VIEW_NOT_DRAWN`），`capture_preview` / `preview_frames` 照常从渲染结果截图。工程加载时编辑器自己会打开的窗口（如上次开着的「AI 合成」窗口）也最小化在程序坞里。旧版本工程的升级对话框仍会弹出。用户自己在像塑里打开的工程不受影响。
- 素材的 `kind`：`package` 素材包、`ai_image` AI 图片、`ai_makeup` AI 妆容（按部位建多个对象）、`custom_gan` 自定义实时变脸、`foreground_sticker` / `face_sticker` 图片贴纸、`filter` 滤镜。素材广场里没有可应用内容的卡片（编辑器点应用也没反应）不列出，只在 `unsupported` 里计数。素材广场单个关键词最多返回 1000 条。广场卡片是异步应用的，工具等对象出现在场景里（最长 60 秒）才返回；新建的渲染组（如「2D 前景」「AI 实时变脸 (1)」）会作为新增对象报告，删除它们用官方 `edit_by_dsl` 的 `delete_render_group` 命令。
- 素材库的搜索接口只匹配标题，很多素材的名字里没有人们会搜的词（美妆 › 腮红里是「雾堇胭」「红玫瑰」，没有素材叫「滤镜」），所以 `library_search` 还会展开名字与搜索词相同的面板或子分类，以及「子分类 + 面板」组合（「复古滤镜」）；「面板 + 其它词」（「韩系滤镜」）只在该面板里按标题搜「韩系」。名字只是包含搜索词的子分类不展开，列在 `related_categories`。每个面板或子分类最多取 300 条（实测子分类 17–125 条）。什么都没匹配到时返回 `hint`。
- `works_*`、`inspiration_*`、`task_*`、`rank_*`、`effect_detail`、`effect_videos`、`effect_search`、`inspiration_search`、`tutorial_search`、`tutorials_list`、`shoot_scripts`、`library_list` / `library_search` / `library_images`、`menu_list` 与当前工程无关，任意一个工程窗口开着即可；不指定工程时由 pid 最小的窗口处理。运营平台的工具不用开像塑：它们用平台给 agent 的只读令牌请求平台，令牌从 `~/.config/xiangsu-ops/token` 读（环境变量 `XIANGSU_PLATFORM_TOKEN_FILE` 可改路径，令牌由运营平台仓库的 `deploy/set-secrets.sh` 生成），平台地址默认 `https://xiangsu.muqian.chat`（`XIANGSU_PLATFORM_URL` 可改）；没有令牌报 `OPS_TOKEN_MISSING`，平台答错误时报 `OPS_HTTP_<状态码>` 带平台的原因。作品类的回答带最近一次取到作品列表的时间 `data_at` 和是否正在重取 `refreshing`。
- 返回资料的方式：
  - 列表默认每页 20 条（服务端上限更小的按上限），只给挑选时要看的字段；要细节用对应的详情工具。
  - 列表里的图片、视频、音频不给地址，给短引用 `*_ref` / `*_refs`（`img:12`、`video:3`、`audio:5`），交给 `image_view`：一个签名 CDN 地址有几百字，实测占列表每条的 43%–93%。引用记在 MCP 服务里，这次运行期间有效（最多记 2 万个，超出时忘掉最久没用的）；详情工具（`inspiration_detail`、`menu_list` 的 `details`）给的是这个对象自己的图，仍给地址；`effect_detail` 的图标和视频是签名长地址，也给短引用。
  - 我们自己的工具回答超过 3 万字时，全文写进 `~/.xiangsu-mcp-ext/outputs/`（24 小时后删除），回答换成文件路径和结构概要（每个字段的值或条数，列表给每条有哪些字段），用读文件的工具按需读，或用分页参数分几次取。3 万是拍的：`task_detail` 原来一次回 4.8 万字，读不全。官方工具原样转发，不受影响；只有官方报错超过 4000 字时（如 `apply_workflow_patch` 校验失败的整段展开）截断，全文写进同一目录。
  - 字段命名：投稿量统一叫 `publish_*`（`publish_count`、`publish_peak`、`publish_total`），跟拍量叫 `follow_shoot`，页面原样给的展示文字（如「1.2万」「¥50」）以 `_text` 结尾，换算过的金额以 `_yuan` 结尾；看不出单位的数（任务奖项的 `money`、`award_amount`）原样给，不换算。
- 灵感、任务、排行榜按编辑器首页活动中心的方式请求（编辑器的登录 Cookie 和签名请求头），读写的都是编辑器里登录的账号。排行榜和成长之路用的是像塑移动版的接口，榜单名和筛选项取值与移动版一致，后端改版时可能失效。灵感和任务详情的接口移动版和编辑器是同一个（2026-11-08 对照移动版 v17.7.0 安装包里的接口逐个实测，返回完全相同），移动版看到的内容都在工具的返回里；热点内容流、任务筛选、每日任务、创新任务这几个移动版接口暂未接入（参数未知，或当前账号没有内容可核对）。
- `inspiration_collected` 用的是首页灵感页「收藏」页和提交窗口灵感下拉共用的 `/creator_api/inspiration/v1/collect_list`（参数取自两个页面的在线脚本，2026-11-10 实测）：不带作品类型 `artwork_types` 时一条都不返回；灵感页只要 0（特效）和 5（表情），提交窗口要 0、5、14，而当前账号还有一条类型 2（模板）的收藏，两个页面都列不出来，所以工具带上 0、2、5、14（试过 0–20，只有 0 和 2 有内容）。别的类型的收藏要是出现，工具也会漏掉。
- 精选（插件的 `my_innovation_status` 取数函数，运营平台按同样的站内信判定；agent 用 `pipeline_works`）：作品发布后没有单独提交精选这一步。官方《优质创作｜精选扶持全面升级》（2026-07-24 版）写的是「精选特效将在审核阶段进行评估判定」，只有 LV3+ 特效师能在提交页勾「精选提报」。被挑中的特效会收到站内信「你的特效正在精选审核中，预估7个工作日完成，请耐心等待。」，2026-11-09 实测 16 个已上线特效里 6 个收到，其中 4 个在上线后二十多秒、2 个在上线后七八个小时；这类消息的链接是 App 内的 `effectcam://flutter?page=/effect-detail&effectId=…`，`effect_id` 从这里取。除了这条站内信，没有接口能看出进没进精选审核：这 6 个特效的精选审核时间线（`review_nodes`，`review_type=2`）都是空的，收益卡片里精选奖的说明对 16 个特效都是「不符合精选标准」。已入选的用作品列表的「官方精选」筛选读：App 给 `/effectcam/v1/artworks` 传 `rating=1`（`rating=0` 或不传是全部，传 `chosen` 报参数错误），当时返回 0 个，和还没有入选作品一致。2026-11-12 第一个入选的特效出现在这个筛选里，同时收到站内信「你的特效被评为精选特效，可获得额外激励和精选标识。」，之后又有「精选特效资产稳定在A2获专属加热曝光>>」「持续创作精选特效均可获得额外曝光>>」这类推广；落选的站内信是「你的特效暂未被评为精选特效，原因为不满足设计精美，你可以参考精选评估标准进行优化。」（2026-11-11）。入选、落选各只见过一条，工具按「被评为精选特效」「暂未被评为精选特效」认，原因取「原因为」到下一个逗号或句号；状态按最近一条结论性的消息定，推广不算，其它认不出的精选消息标 `notified`。
- 作品数据、账号和消息（插件的 `my_effect_*`、`my_profile`、`my_revenue`、`messages_list` 取数函数，不再做成工具，看板复用）的参数取自移动版 v17.7.0 安装包反编译出的 Dart 代码，2026-11-09 用自己的账号逐个实测：作品详情的接口都要 `effect_id`、`app_effect_id` 和 `app_id`（抖音是 184），只给其中一两个时服务端答「参数错误」；数据趋势的 `cycle` 是页面「近7日」「上线后」两个标签的序号加 1，其它值答「参数不正确」；消息按上一页最后一条的 ID 翻页。趋势里按天的曝光和投稿是逐日累计值，数据隔天才更新。等级是数字代码，接口不给对应的字母；投稿门槛以移动版「激励规则」页为准。作品详情里的 `tips` 和 `scarce_category` 两张卡片对试过的特效都没返回内容，有内容时原样放在 `unread`。
- 特效详情、视频、搜索、教程、拍视频激励和拍摄脚本（`effect_detail`、`effect_videos`、`effect_search`、`inspiration_search`、`tutorial_search`、`tutorials_list`、插件的 `shoot_activity`、`shoot_scripts`）的接口取自移动版 v17.7.0 安装包，2026-11-09 实测：特效详情的接口不带 `effect_source` 时答「请求参数错误」，带 0、1、2、3、5、6 都返回同一个特效，返回里另有它真实的来源，所以工具固定带 1；不存在的 ID 答 `code=3000`（「特效不存在」）。同一个特效连查几次，`project`（用到的编辑器能力）、`designer`、平台判定的类型和点赞评论数这几块时有时无，缺的给 `null`。等级 `level_code` 是另一套数字（年轻喜爱榜第一的特效是 25），和排行榜的字母等级对不上。视频接口的「优秀视频」和「作品视频」实测是同样 5 条，前者多了抖音视频 ID 和没截断的标题，工具按视频地址合并成一个列表。搜索每页超过 20 条答 `code=1014`；特效最多翻到 100 条（翻到底核对过），模板和灵感返回的 `total` 是 300（没有翻到底核对）。教程不传分类时返回全部 188 篇，比 13 个分类之和（172）多；文档教程的 `link` 是飞书文档，不登录访问会跳到飞书登录页，agent 读不到正文，视频教程的视频是 CDN 地址，能直接打开。拍摄脚本共 48 条，App 里没有标签名，标签代码按各标签下脚本名的【】前缀归纳（写在 `shoot_scripts` 的说明里）。「拍视频激励」里每个作品能否参加的列表（`/cam_api/activity/v1/effect_list`）没有做成工具：按「未拍摄」筛选返回 0 条，而每个作品的拍摄状态又都是 0，含义对不上。
- 几处上限是在服务端实测的：`rank_list` 和 `rank_subjects` 每页最多 20、`inspiration_list` 每页最多 50（100 会报错）、`inspiration_collected` 每页最多 50（传 100 也只回 50）、专题榜详情一次最多 20。移动版的「特效优秀视频榜」接口对所有榜单都返回空，没有提供。
- 审核记录：编辑器的「拍摄特效管理」（`/creator/v1/effect_list`）只有状态码，原因在像塑移动版的审核记录页（站内信「点击查看未过审原因」打开的 `effect.douyin.com/m/detail?showReviewList=1`）。工具按那个页面的方式取：「上线审核」先读 `review_nodes`（`review_type=1`），没有记录再读 `effect_reviews`；「精选审核」读 `review_nodes`（`review_type=2`）。2026-11-07 实测，被驳回的特效 `review_nodes` 不返回记录，原因来自 `effect_reviews`，如「特效不符合规范：特效中可能含有涉及展示或宣扬不同群体攻击对立类内容」。正文里的 `|<b>…<b>|`、`|<a><href>链接<href>文字<a>|` 等标记按页面的规则去掉，链接放进 `links`。分条原因 `refuse_reasons` 的结构取自页面代码，实测的特效还没带过。别人的特效和不存在的 ID，服务端一律报 `code=1301`（「参数不正确，请正确访问」）。
- 插件的 `my_effects`（看板和 `submit_confirm` 内部用）翻页要把上一页返回的 `sort` 原样传回，`next_cursor` 就是它（传 `cursor` 或 `offset` 都只会拿到第一页，2026-11-07 实测）。服务端不给「还有没有」，工具按「这页满了就还有」判断，所以最后一页正好满页时 `has_more` 仍是 `true`，再翻一页得到空列表。每页上限 50 是拍的：每个未通过的特效要多一到两次请求。
- 只有作者分享到首页的特效才有工程可下载。排行榜的 `effect_id` 和首页作品的 `effect_id` 是同一套编号，`works_by_effect` 按 ID 精确匹配（与首页搜索框的「特效ID」搜索同一个接口，默认在「推荐」里查，首页在「官方工程」里不提供按 ID 搜）。按 ID 搜时「推荐」也能查到只出现在其它分类的作品（2026-11-07 实测 8 个全中，在它们自己的分类里按 ID 搜反而一个都查不到），所以不用跨分类查。
- 首页翻页除了 cursor 还要带上一页返回的 `sortingPosition` 和 `version`（编辑器首页就是这样翻的），只带 cursor 每一页都是第一页；`works_list` 的 `next_cursor` 把三者编在一起。按作品名搜索时，「推荐」翻到底只有约 300 条，「美化」「友友天地」等分类里还有它没有的（「头套」多 46 条、「美妆」多 87 条），所以 `works_search` 默认搜全部分类。服务端偶尔会提前结束一轮翻页（6 轮里有 1 轮停在 249 条），没到 300 条上限的分类会再翻一轮合并；服务端一直给同一页时停下，并把分类列在 `incomplete`。结果分四种：`found` 首页有这个特效的工程；`same_style` 首页没有它，但移动版特效详情页的「做同款」按钮（`/cam_api/feed/v1/get_item_project`）指向首页上的一个工程：接口给出 `guide_project_info.id`（就是首页的 `template_id`）和它所属特效的 `project_id`、`project_name`，工具按这个特效 ID 在首页查到那个作品，它常是别人的另一个特效（「顶美精致淡妆感」指向「可可裸妆」，「你们两个最适合当什么」指向「好友对你都有什么想法」），不是榜上这个特效本身的工程；`same_name` 首页没有它、也没有做同款工程，只有同名作品，`effect_id` 不同，可能是别人的作品，不能当成同一个特效；`not_on_homepage` 拿不到工程（编辑器「我的特效」里的工程下载只对自己的特效开放）。做同款工程在首页查不到时，`same_style` 字段照样给出，`status` 按同名作品的查找结果。每个特效一到四次请求。2026-11-07 实测年轻喜爱榜第一页 20 个特效：10 个 `found`，1 个 `same_name`，9 个 `not_on_homepage`；2026-11-09 加上做同款后再测当天第一页：7 个 `found`，9 个 `same_style`，4 个 `not_on_homepage`，20 个用了约 8 秒。
- 提交窗口是抖音特效平台的网页（`effect.douyin.com/ac/submit-orion`，每次在线加载，安装包里的离线版本较旧，字段也不同）。`submit_prepare` 按页面上的类名和文案找元素，页面改版后找不到时报 `SUBMIT_PAGE_CHANGED`，不会跳过。名称框会在页面的 `aiName` 配置请求回来时重新挂载，先填的内容会被清空（2026-11-07 实测，配置在表单出现约 1 秒后才回来），所以工具等这个请求完成再填，最后再用「提交审核」页的摘要核对一遍。灵感下拉只列当前账号收藏的灵感和热点，每次加载 10 条，不在列表里的用页面的搜索框找；选了和灵感所带任务不一致的任务时，页面会清掉灵感，工具会报 `SUBMIT_BINDING_NOT_APPLIED`。「特效发布设置」页上按账号出现的其它设置（活动、创新声明、作品授权）不填，列在 `other_sections`。
- `submit_confirm` 的协议和结果（2026-11-12 读 9.8.3 安装包里的离线提交页 `pages/submit-orion/index.7e6f25ec.js`）：账号以前同意过协议时页面只显示「已阅读并同意」，否则是一个勾选框，没勾时「提交审核」不可点；点了之后按钮变成 loading，页面上传特效包和工程，再调 `/creator/v1/submit`，结果经 `orionJSB://DYEHSubmitBridge/sendUploadResultEvent` 报给编辑器（成功 `{effectId}`，失败 `{failReason}`），成功后换成「提交成功」页（底部「查看我的特效」，未实名时多一个「实名认证」）。工具在页面里包一层 `window.orionQuery` 记下这份报告，照原样转给编辑器。线上页比离线页新，以上按离线页写，没有在线上页面上验证过失败分支和失败提示（Semi 的 toast）。2026-11-14 线上实际碰到过一次：整个调用 8 秒就结束，按钮不再 loading，既没有这份报告也没有「提交成功」页，作品却在调用结束前 3 秒已经建好、在审核中（「AI 前任撤回的那句话」，92931061）。所以页面没确认的结果一律先到 `my_effects` 里核对，不当成失败。
- `works_download` / `works_open` 走编辑器自己的下载流程，每次解压一份新的到像塑实例目录的 `ProjectCreatedTmp/CreatedFromTemplate/<guid>/` 下。`dest` 副本不含 `Library/` 缓存（编辑器打开时会重建）。
- 下载物不留痕：
  - 编辑器缓存在 `~/Library/Application Support/DouyinAR/Shared/Resources/LokiDownload/TemplateResources/` 的工程包，解压后立即删除（下载前已存在的视为你自己在首页用过的缓存，不动）。
  - 给了 `dest` 时，临时目录里那份随即删除。
  - 每份下载（临时目录或 `dest`）登记在 `~/.xiangsu-mcp-ext/works-downloads.json`。`works_cleanup` 随时删除；没删的在 24 小时后由下一次下载自动清掉（这个时长是拍的：够一个工作日内学完，又不至于堆积，可按需调 `src/works.mjs` 的 `DOWNLOAD_TTL_MS`）。
  - 编辑器窗口正开着的下载不会被删；像塑关窗时不会自己删除这些目录，关窗后再调 `works_cleanup`。
- AI 组合效果在工程里由三部分组成：场景里的「AI 组合效果」图片对象、它绑定的组合效果纹理（`Assets/AI 组合效果/*.oAICombineTextureJSA`，存编译好的 `workflow`、上传后的 `graphTosUri` 和云端草稿 `draftId`），以及 `Graph/graph.json` 里的 AI Graph。「添加对象」菜单里的 AI 组合效果只建对象和一张 `workflow` 为 `{}` 的空纹理，编辑器自己也是先建空壳、再由「应用」填参数，所以 `menu_add` 仍然拒绝它，改用 `ai_combine_new` / `ai_combine_apply`。哪些步骤会连到云端（2026-11-08 读编辑器代码；`ai_combine_new` 和 `ai_combine_apply` 不建草稿是实测，官方 Patch 建草稿、预览视频上传只读了代码，没有实测）：`ai_combine_new` 和本地连线都不联网；官方 `apply_workflow_patch` 每次改完都会把工作流存成账号下的云端 AI 效果草稿（`releaseAIEffect`），此后 `ai_combine_apply` 返回的 `draft_id` 就是这个草稿；官方 `generate_workflow` 扣生图额度；`ai_combine_apply` 上传工作流文件，生成过预览视频时把视频一并上传供审核，自己不建草稿。场景里有变声组件时编辑器拒绝「应用」，工具报 `AI_COMBINE_APPLY_NO_EFFECT`。
- 图生视频（2026-11-14 读 9.8.3 编辑器代码并实测）：工作流原生支持「视频生成」节点（`BuiltinResource/AIGraph/NodeInfo/Image2VideoEffect/node.json`，`AINodeType: Video`，5 个图片输入口 `ParamJSON.Images.0`–`4`、1 个视频输出口），可选模型来自 `AIEffectController` 的视频模型表（`BASE_MODEL_CATEGORY_ID_MAP.videoAllModelKey`），面板里的「图生视频」系列是 Seedance 2.0 Mini（主模型）/ Fast / 2.0 / 2.5，另有肢体驱动、照片唱演、五官驱动。官方 MCP 的 `get_workflow_capabilities` 只列生图基模、`apply_workflow_patch` 只能建生图节点，所以 `ai_video_node` 照节点编辑面板（`VideoSeedanceAdjustment`）的做法：`AIGraphManager.initNodeByName('AI Effect Video')` 建节点，模型的默认 style 经共用的 `AIVideoCtx.styleItemToCtxParams` 再 `node.setStyleParamByStyleItem` 写进节点，参数用 `onStyleParamsUpdate` 改后经 `getCurStyleItem` 写回（分辨率对应的 `DefinitionType` 由编辑器换算）。建好后官方 `get_workflow_context`、`apply_workflow_patch`（绑输入图）、`generate_workflow` 都能照常处理这张图；实测一次 Seedance 2.0 Mini 480p 5 秒约 3 分钟生成完，视频节点出 496×864，效果组合出 1080×1920。生成结果在节点的 `AIResultList`（`localPath` 是编辑器的 AIGC 缓存），`ai_video_results` 读它。`ai_combine_apply` 把它放进场景时编辑器会先把效果组合的结果视频上传供审核（`auditVideoVid`），场景里已有 AI 组合效果时照旧原地更新它、报 `AI_COMBINE_APPLY_NO_EFFECT`。
- AI 妆容（2026-11-11 读编辑器 9.8.1 的 `AIMakeupManager` 和 `AssetAIMakeup` 面板）：
  - 提交调面板实例（`AssetsLibrary.getInstance().aiMakeupManager`）的 `submitMakeupExtract`，任务进面板的记录；它出错时只弹提示（`assetAIVideoToast`），工具把提示原文放进 `AI_MAKEUP_SUBMIT_FAILED`。查询和列表走面板同一组接口（`queryAIGCResult`、场景 `AIMakeUpPC` 的 `queryAITaskHistories`），按面板的 `taskRecordToMessage` 解读。
  - 限制取自面板：文件选择只认 png / jpg / jpeg，提示写「不超过 10MB」；有任务在跑时「立即提取」是禁用的，工具同样拒绝。历史接口一页最多 20 条（同 AI 3D）。
  - 历史记录里的 `cost` 不是额度：账号的 6 条记录里它都等于完成时间减创建时间的秒数（5–8）。编辑器代码里没有扣额度的提示，是否收费以平台为准。
  - 预览用面板的「整妆」预览（`ensurePartPreview(…, 'all')`，把五层按推荐强度叠在内置样例脸 `female.jpeg` 上）。面板另一张预览（`ensureFullMakeupPreview`）把按人脸展开的贴图整张拉伸盖在参考照片上，不对齐五官，实测是一团错位的颜色，没有采用。
  - 导入照面板的 `importSelectedAssets` 逐个部位做：下载到共享缓存 `AIGC/AI 美妆_<部位>.png`，`importExtAsset` 导入并打上 `AIAsset_MakeUp_<task_id>_<部位>` 标记，加载完调面板的 `createCorrespondingEntity` 建层（场景里没有「面部面具」时它连同摄像机和「脸部遮罩纹理」一起建）。不经过面板的勾选，所以不动用户在面板里勾选的项；导入期间把面板的 `isImporting` 置上，面板的导入按钮会等。同一工程第二次导入时编辑器把文件和层自动改名为「AI 美妆_面部 (1)」，不覆盖（实测）。五个部位记 10 步撤销（实测）。
  - 美瞳：面板把 AI 美瞳贴图、强度、反光强度和两种混合模式写给美瞳层上的 `JSScriptComponent`，而 9.8.1 建出的美瞳层上是 `EyeColorV2`，这些写入全部落空，层上是内置默认棕色瞳色、强度 0.8（2026-11-10、11 照面板做法导入的 5 个工程，保存的场景里美瞳贴图都是内置的 `defaultEyeColor`）。工具建层后把同样的值写进 `EyeColorV2`（`makeupTexture`、`intensity`、`reflectionIntensity`、`blendMode`、`reflectionBlendMode`，并照面板的 `opacityTextureEnable: false` 关掉 `isOpacityEnabled`），实测保存后场景文件里是 AI 美瞳贴图和推荐强度，预览里瞳孔自然、没有方块。
  - 实测（2026-11-11，一次）：一张 1 MB 的 PNG 参考图从提交到拿到预览 12.6 秒，云端用时 7 秒；导入五个部位约 7 秒。
- AI 3D（2026-11-08 读编辑器 9.8.1 的 `AI3DManager` 和三个上传面板）：提交、查询、取消走面板同一组云端接口（`submitAIGCRequest` / `queryAIGCResult` / `queryAITaskHistories` / `cancelAIGCRequest`），参数原样照抄；结果解压到编辑器的 `AIGen3D/<task_id>/` 缓存目录，导入方式、命名和缩放（GLB 外层放大 15 倍、点云缩小到 0.3）也与面板相同。几个限制的来源：
  - 精度对应的面数、视频的时长 / 分辨率 / 大小上限、本地模型要有的 20 根骨骼，取自面板组件里没导出的常量（在编辑器里让组件自己跑一遍校验读出来的）。
  - 面板拿视频探测函数量图片，图片读出来宽高大小都是 0，所以编辑器实际只检查了扩展名；工具按面板文案写的 10 MB、4000 像素真的检查。
  - 本地 FBX 缺标准人形骨骼时编辑器只弹提醒、照样提交，工具也照样提交，在返回里给 `warning`；没有骨骼、骨骼超过 100 根或面数超过 12 万时编辑器拒绝，工具同样拒绝。
  - 同一类型运行中的任务满 3 个时面板拒绝提交，工具先查历史里运行中的任务数，同样拒绝。
  - 历史接口一页超过 20 条时返回 5062「超出最大条数限制」（实测，面板自己一页取 5 条），所以 `ai3d_tasks` 的 `count` 最多 20。
  - 结果接口不带任务的输入，导入 3D 动画时到历史里按 `task_id` 找回所用的模型，按面板的方式给文件起名（如「全身.fbx」）；最近 200 条里找不到就用 `task_id` 命名。
  - 实测耗时（2026-11-08 各跑一次）：图生 3D（medium）约 13 分钟，3D 动画（内置全身模型、约 3.5 秒的挥手视频）约 9 分钟。
  - 编辑器代码里没有扣额度的逻辑或提示，是否收费以平台为准。
- AR 视频（2026-11-08 读编辑器 9.8.1 的 `ARVideoManager`、`ARVideoPage` 和 `VideoMatting/ARVideo*`）：
  - 生成不只是一次云端请求：云端（Seedance）出视频后，编辑器还要在本机下载、抠像、打包成混合透明视频并做预览，审核、合成、历史缓存都在 `ARVideoManager` 里，关键步骤是模块内部函数，拿不到，所以四个工具都直接调用面板用的那个实例（`AssetsLibrary.getInstance().arVideoManager`）的 `captureInput`、`generate`、`refreshRecords`、`cancelTask`，导入调用 `importARVideosToCurrentProject`。面板和工具栏的后台任务列表因此看到的是同一份任务。
  - 编辑器没有「模式」开关：主体是视频、不写描述、不加参考素材时直接抠像，其余情况都按描述生成新动作。`mode` 是工具自己的参数，用来挡住两种意图不符的组合。
  - 限制取自编辑器：包括主体最多 9 张图、3 段视频，描述最多 2000 字，动作最短 4 秒；动作时长上限、输入视频总时长上限和投影默认值来自编辑器开关（`dyeh_ar_video_max_output_duration_s`、`dyeh_ar_video_max_input_duration_s`、`dyeh_enable_ar_video_shadow`），9.8.1（2026-11-08）读到的是 15 秒、15 秒、开，9.8.3（2026-11-14）是 30 秒、30 秒、开，以 `ar_video_tasks` 返回的 limits 为准。9.8.1 的面板受入口开关 `dyeh_enable_ar_video_entry`（编辑器默认关）和 `isARVideoEntryEnabled` 控制；9.8.3 去掉了这两样，面板直接列在素材库导航里，工具按导航里有没有「AR 视频贴片」判断能不能用。
  - 一个窗口里面板同时只跑一个「当前生成」，其余在后台；工具提交后把自己的任务转到后台，所以可以连续提交，同时在跑的上限是 10 个。
  - 结果在提交它的那个工程窗口里合成；别的窗口第一次看到这个任务时要自己下载并合成一次（显示 `restoring`）。
  - 次数：编辑器只有用完时的提示「模型使用次数达到上限，请提升特效师等级以获取更多次数」（错误码 2038），没有查询剩余次数或单次消耗的接口。
  - 实测（2026-11-08，一次）：一张 1024×1536 的小猫图、`mode=motion`、10 秒、不加投影，云端 2 秒接受，约 6 分钟后在本机合成完，输出 720×720、24 fps、带原声。之后在另一个工程窗口里查这条任务，直接就是 `succeeded`（编辑器的生成记录缓存在 `Shared/Resources/ARVideoHistory/` 下，各窗口共用，本机合成的文件还在就不重做）。
  - 导入后的场景（同日实测，导进一个空场景）：渲染组「AR跟踪」›「AR平面跟踪」（`MeshRenderer`，内置 AR 平面网格和「蒙版阴影」材质）›「AR 视频主体 1」，加一个「AR摄像机」（`Camera`、`DeviceTracker`）；空场景还会多出「通用」组。「AR 视频主体」上有 `Image`（`texture` 是导入的 `Mp4Texture`「混合透明 MP4 播放器」，`loopCount=-1` 无限循环）、`LookAt`（朝向 AR 摄像机）、`AudioComponent`（原声，`autoPlay=false`）和编辑器内置的 `ARVideoAudioController`（`playOriginalAudio_target`、`originalVolume_target`、`videoTexture_target`，让原声跟着视频播）。脚本里控制视频：`texture.getControl()` 的 `play()` / `pause()` / `resume()` / `stop()`，事件用 `APJS.EventManager.getObjectEmitter(texture)` 监听 `APJS.Mp4Event.*`（取自内置节点「视频纹理播放器」的实现 `CGVideoTexturePlayer.js`）。同一个工程第二次导入时对象怎么排还没有实测。
  - 预览图 `preview_image_file` 是用编辑器自带的 ffmpeg 从预览视频均匀取 6 帧拼成的横条，存在 `~/.xiangsu-mcp-ext/ar-video/<task_id>.jpg`，预览视频重建后自动重做。
- 9.8.3 新功能的依据和实测范围（2026-11-14 读编辑器 9.8.3 的源码）：
  - 画面特效、实时变脸、图片编辑器 AI 都照面板和编辑窗口自己的调用写：画面特效先清空面板输入（`leavePage`）再填描述、时长和参考素材，参考视频等到审核通过才提交，提交后转到后台；实时变脸的训练按面板分两种流程（真人搞怪的 preset 是 `fun`，要先生成候选图、挑满 30 张），导入前照训练完成卡片的做法下载模型文件和预览视频、生成封面；图片编辑器的消除和重绘靠在原图上把区域涂成绿色棋盘格（`#00ff00`，透明度 0xc0 和 0x48 交替）告诉云端范围，格子在编辑器里是 12 个屏幕像素，这里按图片长边每 600 像素 12 像素算（拍的，编辑器视图的实际尺寸不知道）。
  - 实测过：三组功能和预览输入在 9.8.3 上自检全部通过；实时变脸的风格和剩余训练次数（当时 5 次）、两个面板的历史列表能读出来（账号里还没有任务）。提交画面特效、实时变脸的预览和训练、超清 / 抠图 / 消除 / 重绘都会占用账号的模型次数或训练次数，没有实测，第一次用时核对返回。
  - 模拟声音：编辑器内置 Agent 的「试玩」会话打开时会重载预览、注入运行时，之后发给预览的音量、音高、关键词事件才会变成 `AudioDetection` 的结果；会话关掉再重载一次就恢复原样。实测（一个每 0.4 秒打印一次 `VolumeDetector.getResult()` 的脚本）：喂 0.12 持续 2 秒读到 5 次 0.12、再喂 0.03 持续 1.2 秒读到 3 次 0.03，前后都是 0。预览暂停时重载等不到完成事件（实测切完手势视频后超时 10 秒），所以开关会话前先恢复播放。
- 做素材的工具不连像塑窗口：文字和图片用 Skia（`@napi-rs/canvas`，首次用到时才加载，冷启动约 2 秒），字体默认是像塑自带的抖音体（`/Applications/Douyin AR.app/Contents/Resources/BuiltinResource/fonts/`，也可传 .ttf / .otf 路径）；音效和预览视频用像塑自带的 ffmpeg（`BuiltinResource/ffmpeg/<架构>/ffmpeg`）。音效预设移植自各特效工程的 `make_sfx.py`，没有随机噪声的预设和原脚本逐采样一致（最大差 5e-10），带噪声的用自己的随机数，听感一样、采样不同；呼啸声原脚本是 FFT 频带滤波，这里换成中心 2500 Hz、Q 0.7 的二阶带通。
- 预览模特写的是像塑共享的 `PreviewResources.json`（所有工程窗口共用），改之前备份到 `~/.xiangsu-mcp-ext/preview-resources-backup/`（留最近 10 份），保留原文件的权限（编辑器装的是 0666）。`scene_set_layer` 改之前把场景文件备份到 `~/.xiangsu-mcp-ext/scene-backups/<工程路径的哈希>/`（留最近 10 份，旁边的 `project.txt` 写着是哪个工程）。
- 预览重载有延迟，应用后用 `interact_by_dsl` 先 `wait` 2–3 秒再截图更稳。
- 资源删除不可撤销；对象删除可以在编辑器里撤销，但已删除的资源不会回来。
- 「孤儿资源」只按场景直接引用判断（资源的编辑器 guid 是否出现在场景序列化数据里）。只通过材质等间接引用的资源不会被判为孤儿。
- 素材放进场景时，编辑器会按对象名再建几个文件夹（如 `复古清冷_滤镜`、`复古清冷_美妆`），保存时对象还在才会写到磁盘。`object_remove` 把这类只在编辑器里的路径单独列在 `editor_only_paths`，对象删除后下次保存就会消失，不用删；`unused_paths` 只含磁盘上真实存在的路径，可以照着删（用 `resource_delete_unused`）。

## 安装（macOS）

需要 Node.js 24+ 和已安装的像塑。安装即表示你同意下面「协议与声明」里的用途限制：只用于学习和个人制作，不得用来抄袭他人作品。

在 MCP 客户端里注册一个 stdio 服务即可，一行：

```bash
claude mcp add -s user xiangsu -- npx -y @muqian/xiangsu-mcp-plus   # Claude Code
codex mcp add xiangsu -- npx -y @muqian/xiangsu-mcp-plus            # Codex
```

Cursor 等用 JSON 配置的客户端：

```json
{
  "mcpServers": {
    "xiangsu": {
      "command": "npx",
      "args": ["-y", "@muqian/xiangsu-mcp-plus"]
    }
  }
}
```

服务每次启动时检查编辑器插件，没装、版本比自己旧或者插件指向的代码已经不在时，自动装到 `~/Library/Application Support/DouyinAR/Plugins/v<编辑器版本>/Local`（像塑升级后换了版本目录也会自动补装）；已装的是同版本或更新的就不动，所以同一台机器上开着几个不同来源的服务也不会来回覆盖。插件按绝对路径加载代码，而 `npx` 的缓存随时可能被清理，所以从 `npx` 运行时会先把 `editor-plugin/` 复制到 `~/.xiangsu-mcp-ext/editor-plugin/<版本>/`，插件加载那份复制；从源码目录或 `npm install -g` 的目录运行时直接加载原处，不要挪动。安装结果（新装、未动或失败原因，例如像塑没装或还没启动过）在 `ext_status` 的 `plugin_install` 里。

插件只在安装后**新打开的工程窗口**里加载；第一次装好后，已开着的窗口要保存后重开。

Codex 默认单次工具调用 60 秒、服务启动 10 秒超时，而打开工程、提交准备、AI 妆容、AI 3D 和 AR 视频生成要等几十秒到几分钟（`ar_video_submit` 最长 20 分钟），第一次 `npx` 启动还要先下载依赖，要在 `~/.codex/config.toml` 里调大：

```toml
[mcp_servers.xiangsu]
command = "npx"
args = ["-y", "@muqian/xiangsu-mcp-plus"]
startup_timeout_sec = 60
tool_timeout_sec = 1500
```

它已经包含官方工具，不必再单独配置官方的 `xiangsu-mcp-manager`。如果你还在用像塑自带的 `xiangsu-effect-editor` skill，它要求客户端里存在名为 `xiangsu-mcp-manager` 的服务；这种情况下保留官方配置即可，两者可以并存。

从源码运行（开发用）：

```bash
git clone https://github.com/Muqian-Sun/xiangsu-mcp-plus.git
cd xiangsu-mcp-plus
npm ci
claude mcp add -s user xiangsu -- "$(which node)" "$PWD/src/server.mjs"
```

`node scripts/install.mjs`（npm 全局安装后是 `xiangsu-mcp-ext-install`）不看版本，把插件强制指回这份代码，用于从别的来源切回源码目录。

### 更新后怎么生效

- 改 `editor-plugin/library.cjs` 或 `editor-plugin/features/*.cjs`：插件在下次调用时按修改时间自动重载，不用重开窗口；改坏了返回 `LIBRARY_RELOAD_FAILED`，旧版本继续运行。新增插件方法写进对应 feature 的 `METHODS`。
- 改 `editor-plugin/runtime.cjs`：重开工程窗口。
- 改 `src/`：在 MCP 客户端里重启这个服务。

## 开发

- `npm test`：用模拟的编辑器模块测插件逻辑；画图的测试用 `test/fixtures/` 里裁出的思源黑体子集（SIL OFL，协议在同目录），CI 机器上没有中文字体也能跑；用 jsdom 按线上结构搭的提交页测填写和送审流程；用内存传输测 MCP 工具、官方转发、工程窗口编排。
- `node scripts/mcp-call.mjs <tool> '<json>' [...]`：新起一个服务按顺序调工具，图片写到 `<临时目录>/xs-mcp-call/` 下每次运行一个子目录（一小时后清理）。`scripts/official-call.mjs` 直调官方 MCP，图片同样放在 `xs-official-call/` 下。
- `node scripts/call.mjs <method> '<json>' [--pid N]`：直调插件。
- `node scripts/e2e.mjs <工程路径> <关键词> [标题]`：搜索 + 应用 + 未知 ID 报错的端到端检查（会真的导入素材，只对测试工程用）。
- `config.local.json` 里 `devEval: true` 时可用插件方法 `dev_eval` 在编辑器进程里执行探测代码（`scripts/call.mjs dev_eval '{}' --code-file x.js`，`scripts/dump-source.js` 可导出模块源码）。同一个开关也管 `scripts/call.mjs` 的 `eval` / `describe`；三者都在每次调用时读取开关，改回 `false` 在开着的窗口里立即失效。**日常使用保持 `false`**：它能在编辑器进程里执行任意代码。
- 环境变量 `XIANGSU_MCP_EXT_STATE` 可改状态目录（测试用），`XIANGSU_MCP_URL` 可改官方 MCP 地址。

### 依赖的编辑器内部接口

完整清单在 `editor-plugin/features/assets.cjs` 的 `REQUIRED`（按功能分组），`ext_status` 会逐项核对。主要有：

- 素材库：`@orion/Business/AssetsLibrary/Core/Api/{getAssetCategory,getAssetList,search}`、`.../Control/AssetsLibraryNav/{util,const}`、`.../Control/util.downloadLokiFile`
- 素材广场与收藏：`.../Core/Api/{getAIAssetCategory,getAIAssetList,collect,getAssetSecondPanel,publishAsset}`、`.../Core/Control/AssetsLibrary` 的 `AssetsLibrary.getInstance()`（其中的 `AIAssets.applySquareAsset`、`AIAssetPictureCtx`、`AIAssetMakeupCtx`、`UGanManager` 与 `getAssetItemByQuery`）、`@orion/Business/API/ai_effect_api.getDYEHFileUrls`
- 导入：`@orion/orion-sdk/EditorFramework` 的 `Resource.AssetPackageManager.instance.import`、`UndoSystem`、`PreviewSyncer`
- 菜单：`@orion/orion-sdk/orionui` 的 `ExtensionManager` / `I18n`，`DynamicMenuConfigInfo`，`SceneOpsService.createEntity`，`HoverTipsMap`
- AI 组合效果：`AIEffectWindow/AICombinationToolPanel/Core/AIGraphProjectUtils.createAIGraph`（「新建工作流」按钮用的同一个），`.../Core/Manager/AIGraphManager` 的 `getInstance`、`addGraph`、`getGraphById`、`switchGraphbyGuid`、`editorPanelApply`（「应用」；失败时不抛异常，而是在 `BusinessEventManager` 上发 `AIEffectShowToast`，工具监听它并以场景里出现新对象为准）
- AI 妆容：`AssetsLibrary/Core/Control/AIMakeupManager/AIMakeupManager`（面板的管理器，经 `AssetsLibrary.getInstance().aiMakeupManager` 取实例：`submitMakeupExtract`、`taskRecordToMessage`、`updateTaskProgress`、`ensurePartPreview`、`createCorrespondingEntity`）、`.../AIMakeupManager/const`（场景名、部位和顺序）、`ai_effect_api` 的 `queryAIGCResult` / `queryAITaskHistories`、`Utils/LokiAsset/utils.downloadTemplateFile`、`ResourceImportHandles`（`importExtAsset` + 加载回调），美瞳另用 `EyeColorComponentEditor.setProperty`
- AI 3D：`AssetsLibrary/Core/Control/AI3DManager/{const,utils}`（场景名、模型 ID、缓存目录、结果文件路径）、`@orion/Business/API/ai_effect_api`（提交 / 查询 / 历史 / 取消）、`@orion/Business/API/upload_api`（`uploadFileCommon`、`uploadToSpace`）、`AIEffectWindow/controller/apiUtils.QueryTaskResult`（主体识别的轮询）、`Utils/LokiAsset/utils.downloadTemplateFile`、`ResItemExtraData/ResourceImportHandles`（`importExtAsset` + 加载回调）、`EditorFramework` 的 `APJS.FbxLoaderAPJSWrapper`（检查本地模型）和 `Extension.Scene.AssetSceneObjectCreationSystem`、`PreviewManager.checkIsValidVideoFile` / `getFirstNonBlackFrame`、`@orion/config/LegacyGlobalConfig.url`（内置模型的绝对路径；`orionui` 的 `url` 给的是相对路径）
- AR 视频：`AssetsLibrary/Core/Control/ARVideoManager/ARVideoManager`（面板的任务管理器，经 `AssetsLibrary.getInstance().arVideoManager` 取实例）、`VideoMatting/{ARVideoGenerationContract,ARVideoAudit,ARVideoAnalytics,ARVideoProject}`（限制与开关、审核状态、生成模式、导入）、`AssetsLibrary/Core/Control/AssetsLibraryNav/{util.getDefaultNavList,const.NavItemKey.ARVideo}`（入口是否在导航里）、`Utils/Ffmpeg.ffmpegExec`（抽帧预览图）
- 工程窗口：`OpenProjectFromEditCommand` + `EditSender`（与编辑器自己的 `launchProject` 同一请求，9.8.1 起首页进程只认它）；关窗照 `closeProjectAndBackToHome` 的顺序做，去掉第一步的 `ShowHomeWindowCommand`（`EditorFramework.Project.unload`、`Analytics/AnalyticsBusiness.AnalyticsBusinessPlugin.instance.flush` / `safelyExitApplication`）；不上屏包住 `orionui.Window.prototype` 的 `show`（改为 `showMinimized`，缺 `WindowStyle.ButtonMin` 的先补上）、`focus`、`requestActive`、`raise`、`bringToTop` 和 `OrionApplication.App` 原型上的 `activate`，编辑窗口看 `EditWindow/EditWindowController`
- 画面特效：`AssetsLibrary/Core/Control/AIVisualEffectManager/AIVisualEffectManager`（面板的管理器，经 `AssetsLibrary.getInstance().aiVisualEffectManager` 取实例：`resume`、`leavePage`、`updatePrompt`、`updateDurationSeconds`、`updateReferenceMedia`、`getReferenceAdmissionError`、`submit`、`queryTaskList`、`importCurrentResult`、`cancel`，以及时长、参考素材和并发的限制）、`.../AIVisualEffect/{visualEffectInput,downloadGeneratedVisualEffectPreview}`（素材检查、预览视频下载）
- 实时变脸：`AssetsLibrary/Core/Control/AssetUGan/{UGanManager,utils,const}`（面板的管理器，经 `AssetsLibrary.getInstance().UGanManager` 取实例：风格、预览、选图、训练、导入；`utils` 判断任务阶段、查训练次数、模型的本机路径），`ai_effect_api.queryAIGCResultWithBizInfo`（刷新任务进度），`Utils/LokiAsset/utils.downloadTemplateFile`（下载模型），`PreviewManager.getFirstNonBlackFrame`（预览视频封面）
- 图片编辑器：`ImageEditor/utils/imageEditAIGen.requestImageEditorAIResult`（超清、消除、重绘，场景 `ai_effect_api.AI_SCENE.AIMattingGenPC`）、`ImageEditor/utils/imageSegmentationUtil` 的默认导出（抠图）
- 预览输入：`Agent/EHCommand/EHPreviewCommand`（`previewTouchMove`、`seekToTime`、`switchGestureVideo`、`reloadSticker`）、`Agent/EHCommand/AgentPlayAudioInputService`（模拟声音）、`Agent/EHCommand/AgentPlaythroughRuntimeSession`（试玩会话的开关，重载预览时注入运行时）、`Preview/PreviewManager` 的 `PreviewStreamState`（暂停的预览先恢复，否则重载等不到完成事件）
- 首页作品：`@orion/Business/HomeWindow/TemplatesPanel/Request/{templatesPanel,templatesCategory}`、`.../Model/util.transformTemplate`、`.../Model/DownloadTemplateModel`；打开作品用 `OpenProjectFromEditCommand` 的 `openTemplate`
- 交付：`IconCreationNew/controller/IconPreviewManager`、`IconCreationNew/UI/BottomPanel/DYEHIconUploadHelper.uploadIcon`（上传图标，写回 `iconUri`）、`Submission/SubmissionExtension/EffectSubmissionExtension`（提交接口 `submit()` 只做前置检查并打开提交窗口）、全局 `App._windows`（编辑器每次都新开提交窗口和特效检测窗口、不保存引用，按类名 `DYEHEffectSubmissionWindow` / `DYEHPerfTestWebWindow` 在这里找到它们；提交窗口和特效检测窗口都是网页窗口，网页里的脚本经 `webview.evaluateJavascript` 注入，结果经窗口的 JS bridge 以 `orionJSB://` 查询传回）、`PerfTest/PerfTestExtension`、`EditWindow/ToolBar/MobilePreview/backendHelper`、`effectExporter.exportEffectPackage`
- 灵感、任务、排行榜：`BusinessCommon/UrlConst` 的 `Domain.kBackendApiURL` 与 `DomainPath.{kActivityAPI,kTaskListAPI,kGrowthTaskList}`、`orion-sdk/orionui` 的 `CookieManager`、`BusinessCommon/Utils` 的 `PlatformUtils.genSignData` / `UserAgentUtils.userAgentGenerator`、`HomeWindow/ActivitiesCenter/Common/types`（任务状态、`getTypeName`）、`InspirationDetail/View/const` 的收藏类型、`Agent/AgentInspirationBridge`
- 音乐：`EditWindow/Inspector/MusicLibrary/{Model/MusicCategoryModel,Model/MusicListModel,Component/MusicListComponent/MusicSquareManager}`
- 预览帧：`Business/Preview/PreviewManager` 的 `cacheCurrentFrame` / `captureScreenshotToMemory`（渲染结果；9.8.1 前官方截图也走这组调用）；重置用 `PreviewSyncer.requestReloadSticker` 加 `PreviewReloaded` 与 `PreviewTextureUpdated` 事件；后台帧率用 `EditWindow/BackgroundModeManager.setRecordingMode`；窗口是否可见看 `EditWindow/EditWindowController` 的窗口和 `orionui.WindowState`

## 协议与声明

代码以 [MIT 协议](LICENSE) 开源。另外请注意：

- **用途限制：本工具只用于学习和个人制作。禁止用它抄袭他人作品**：不得把通过本工具看到、下载或套用的他人作品（首页作品工程、排行榜特效、素材广场里其他创作者分享的素材等）原样或稍作修改后发布、投稿、商用，或当作自己的原创。参考别人的做法学习思路可以，作品要自己做。MIT 协议针对的是本项目自己的代码，不改变他人作品的权利归属。
- 本项目是个人开发的非官方工具，与字节跳动、抖音、像塑没有任何关联，也未获其认可或支持。「像塑」「抖音」「Douyin AR」等名称和商标归各自权利人所有。
- 仓库只包含本项目自己的代码，不包含像塑的程序、源码或任何素材。通过本工具访问的官方素材、首页作品，其版权归像塑或原作者所有，使用须遵守像塑 / 抖音的用户协议和平台规则。
- 首页作品只用于学习参考：不要把下载的工程、素材放进公开仓库或转发给他人，学完用 `works_cleanup` 删除。
- 本工具调用的是编辑器内部接口，可能随像塑升级失效，也可能被平台限制。使用风险自负，作者不对因使用本工具造成的账号、数据或作品损失负责（详见 MIT 协议的免责条款）。

## English

Unofficial MCP extension for Douyin AR (像塑) on macOS. One stdio MCP server proxies every tool of the editor's official MCP (with automatic reconnects) and adds what the official server cannot do: browse/search/preview/apply official library assets, browse/search/download or open the homepage works (official projects and published effects) as full projects an agent can read and learn from (rank-board effects are looked up there by effect id, though effects whose authors did not share them on the homepage have no downloadable project; every download is registered and deleted by works_cleanup or after 24 hours), add any item of the editor's "add object" menu (toolbar makeup / reshape / AI face effects), create AI combine workflows (the photo is sent to the cloud and generated from the workflow) and apply them to the scene the way the AI effect window does, leaving node editing and preview generation to the official workflow tools, extract makeup from a reference portrait with the asset library's AI makeup panel (five face-part textures with recommended strengths, a preview on the editor's sample face) and import it as makeup layers the way the panel does, also writing the AI pupil texture the 9.8.1 panel fails to apply, run the asset library's AI 3D generation (image → static mesh, a video's human motion → an animated FBX with the standard humanoid skeleton, an orbit video → a 3D Gaussian splat) and import the results the way its panel does, run its AR video generation (a subject image or video → a matted video of the subject doing a described motion, placed as an AR plane sticker) through the panel's own task manager, list a project's makeup layers with the face part, colour and strength of each (from the layer's region and its texture's pixels when the name says nothing), set FaceWarpX brush intensity, prepare delivery (setting and uploading the icon, local and cloud effect checks, filling in the submit window — name, trigger hint, camera, inspiration, task — up to its final step, then, once confirmed, ticking the creator agreement and pressing 提交审核 to send it to review, phone preview QR codes, binding received creator tasks or inspirations), read the signed-in account's inspirations and tasks (collect inspirations, receive tasks) and the mobile app's rank boards, list the account's submitted effects with their review status and, for rejected ones, the reviewer's reason and full review timeline, use Douyin music, open/create/close project windows, and remove objects together with resources only they used. It also replaces the one-off scripts effect projects kept writing, without an editor window: icons cropped from preview frames with a caption and a list-size comparison sheet, synthesized sound effects (ported from those scripts) as MP3 through the editor's ffmpeg, outlined / gradient text and rounded panels as PNG (rendered with Skia, the editor's built-in fonts by default), your own preview models added to the editor's preview list, and render layers / camera layer masks set in a saved scene. For editor 9.8.3 it drives the asset library's new visual-effect generation and custom real-time face (UGan) training panels, the image editor's AI tools (upscale, remove, repaint, matting), and preview input the official server rejects: simulated microphone volume, pitch and keyword hits through the editor's built-in agent playthrough session, seeking, touch moves and hand-gesture videos. It works through a small editor plugin that exposes a token-protected RPC on 127.0.0.1 inside each project window. Relies on editor internals (verified on 9.7.2); `ext_status` reports any missing internals. Register it as a stdio MCP server in one line, e.g. `claude mcp add -s user xiangsu -- npx -y @muqian/xiangsu-mcp-plus` or `codex mcp add xiangsu -- npx -y @muqian/xiangsu-mcp-plus` (for Codex also raise `tool_timeout_sec`, since some tools wait minutes). At startup the server installs the editor plugin when it is missing, older, or its code is gone (copying the plugin code out of the npx cache first) and leaves an equal or newer one alone; `ext_status` reports the outcome. Project windows already open load the plugin after they are reopened.

**For learning and personal creation only. Do not use it to copy other creators' works**: works you view, download or apply through this tool (homepage projects, ranked effects, assets other creators shared) must not be republished, submitted, used commercially or passed off as your own, as is or modified. Licensed under [MIT](LICENSE), which covers this project's own code only. Not affiliated with or endorsed by ByteDance / Douyin; all product names and trademarks belong to their owners. The repository contains no editor code or assets. Official assets and homepage works accessed through this tool belong to 像塑 or their creators and are subject to the platform's terms; use downloaded works for learning only, delete them with works_cleanup when done, and do not redistribute them.
