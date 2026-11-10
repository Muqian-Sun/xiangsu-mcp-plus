# xiangsu-mcp-plus

[![test](https://github.com/Muqian-Sun/xiangsu-mcp-plus/actions/workflows/test.yml/badge.svg)](https://github.com/Muqian-Sun/xiangsu-mcp-plus/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey) ![node >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)

像塑（Douyin AR，macOS）的 MCP 扩展：**一个 MCP 服务**同时提供像塑官方 MCP 的全部工具，以及官方 MCP 够不到的编辑器能力。

- 官方工具原样转发（`get_scene`、`edit_by_dsl`、`capture_preview`、`save_project` 等），像塑重启后自动重连，官方工具列表变化时通知客户端刷新。官方 MCP 每次调用只回一个完整的 JSON，请求发出后连接断了的调用可能还在编辑器里跑（生成类会扣额度），所以不自动重发，报 `OFFICIAL_MCP_DISCONNECTED`；连不上编辑器（什么都没执行）报 `OFFICIAL_MCP_UNAVAILABLE`。插件和官方调用都不受 Node 自带 `fetch` 的 300 秒响应头超时限制，等多久只看各工具自己的超时。唯一的例外是 `capture_preview`：9.8.1 起官方截图是给窗口里的预览区域拍照，窗口最小化或不可见时是黑的，这时改为重置预览、等到重载后的画面，从预览的渲染结果截取并缩小到官方的 320×569（不含界面元素）；窗口可见时照旧转发，这时刚改完场景或换了预览视频可能还是旧画面（工具说明里写了这一点），要确认新画面用 `preview_frames`。
- 官方素材库：浏览、搜索、看封面、应用（脸部变形、美型、AI 实时变脸、美妆、滤镜、贴纸、画面特效等），流程与素材库面板相同；包括「素材广场」（其他创作者分享的现成 AI 图片、AI 妆容、自定义实时变脸、贴纸和素材包，应用时不重新生成、不扣额度）和自己的「收藏」。
- 「添加对象」菜单：工具栏美妆 / 美型 / AI 实时变脸里的全部官方功能项（美容、面部生成、表情生成、性别年龄、五官处理、身体换装等），可看示意图后按菜单项 ID 添加。
- AI 组合效果（用户拍照后在云端按工作流出图或出视频）：像 AI 效果窗口的「新建工作流」一样建工作流，交给官方工作流工具编辑，再像「应用」一样放进场景。
- 素材库「AI 3D」：图生 3D 模型（一张图 → 静态 GLB 网格）、3D 动画（视频里人的动作 → 套到带标准人形骨骼的 FBX 上）、高精度模型重建（实物环绕视频 → 3D 高斯点云），提交、等待、取消任务，把结果导入工程，请求和导入方式与面板相同。
- 素材库「AR 视频」（AR 视频贴片）：一张主体图或一段主体视频，按动作描述和参考素材生成新动作（或直接抠像），抠好的视频作为 AR 平面贴片放进场景；提交、看抽帧预览、导入、取消都驱动面板自己的 `ARVideoManager`。
- 首页作品：浏览、搜索、看封面，下载完整工程到本地或直接在编辑器里打开（官方工程和已发布的作品），供 agent 读取场景、脚本和资源，学习别人的做法；下载的东西都有登记，用完即删，最长保留 24 小时。
- 交付：设置并上传图标、特效检测（和编辑器里点「特效检测」一样，云端检测）、填好提交窗口（名称、触发提示、摄像头方向、灵感、任务，一直走到「提交审核」页并等检测跑完；最后的「提交审核」由你来点）、手机预览二维码、把已领取的任务或创作灵感绑定到工程。
- 抖音音乐：按分类或关键词找歌，设为特效音乐。
- 灵感、任务、排行榜：首页「灵感」页签和活动中心的任务（征集任务、成长任务），以及像塑移动版才有的排行榜（年轻 / 男生 / 女生喜爱榜、每日投稿榜、热玩互动榜、跟拍榜，各榜按两级分类细分；热点榜；专题合集里两百多期主题特效榜和模板榜；创新计划月榜和官方精选）和成长之路（特效师等级、奖励和各目标进度），用编辑器里登录的账号读取；可收藏灵感、领取任务。
- 热点和热梗：抖音实时热点榜（每条的分类、热度走势、站内已有特效数、热门视频，用像塑移动版的接口），以及不用登录的百度热搜、B 站热门视频和热搜词。
- 看别人的特效、学做法：像塑移动版的全平台搜索（特效、模板、灵感、教程），任意特效的详情（等级、受众、平台判定的类型、用到的编辑器能力、作者）和用它拍的热门视频，排行榜上没分享工程的特效找「做同款」指向的首页工程；官方教程、本期「拍视频激励」活动和官方拍摄脚本。
- 我的特效审核：自己提交过的特效和审核状态，审核不通过的具体原因和完整审核记录（编辑器里只显示「审核未通过」，原因原本只能在像塑移动版的审核记录页看到）。
- 我的数据：像塑移动版「作品详情」「我的」「钱包」「消息」页的内容：每个特效的曝光、投稿、播放、按天的趋势、投稿等级和升级还差的投稿、流量状态、收益明细；账号的总览数字和收入；站内信（上线、冷启动流量提示、精选审核、任务完成、获奖公布等）；所有任务里自己作品的评定。
- 塑型画笔（FaceWarpX）强度：官方能读不能写，这里按检查器滑块的方式改。
- 工程窗口：新建空白工程（首次保存到指定目录）、打开、关闭。
- 干净删除：删除对象时找出只被它使用的资源和它导入时带进来的素材包文件夹，确认后删除。

> 非官方项目，与字节跳动 / 抖音无关。依赖像塑编辑器的内部模块（9.7.2 实测），像塑升级后可能失效；`ext_status` 会逐项自检并列出缺失的接口。仓库不包含任何像塑的程序、代码或素材。
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
| `project_open` / `project_new` / `project_close` | 打开已有工程、新建空白工程并保存到指定目录、关闭工程窗口（有未保存改动时默认拒绝） |
| `image_view` | 看图：列表类工具返回的引用（`cover_ref`、`gif_ref`、任务内容块的 `image_refs` 等，形如 `img:12`）、详情类工具返回的地址（灵感 `images`、菜单示意图）或本机图片路径都放进它的 `images` 数组；视频和音频引用（`video:3`、`audio:5`）返回原地址；一次最多 8 张，动图等大图一次给不完时把没给的列在 `not_returned` 里（单次响应不超过 MCP stdio 的 10 MiB 上限） |
| `library_list` / `library_search` | 官方素材库面板清单（不传 `panel_key`，含素材广场、收藏）和面板里的分页列表、关键词搜索：逐个面板查标题以拿全结果；词正好是面板名或子分类名时也带出那里的素材（「滤镜」「腮红」「复古滤镜」），按标题匹配程度排序，`queries` 一次搜多个词，返回各面板条数和展开了哪些分类，结果缓存 10 分钟供翻页；每条素材带 `kind`、封面 `cover_ref` 和命中方式 `matched`；第一页还附带「添加对象」菜单里同名的项到 `menu_items`（如「脸蛋天才」，用 `menu_add` 加） |
| `library_images` | 一张 AI 图片卡片的整组结果图地址（按 `image_index` 编号） |
| `library_apply` | 下载素材包、校验 MD5、导入并放进场景（可撤销）；素材广场卡片按 `kind` 走编辑器自己的应用流程（AI 图片可用 `image_index` 选第几张）；返回新增对象（素材连带建出渲染组时，组下面这次新加的对象列在 `contents`）和素材包文件夹；素材广场卡片不给 `file_size`（恒为 3409，没有意义） |
| `works_list` / `works_search` | 首页作品分页列表（每页带上全部分类：推荐、官方工程、新手必做、游戏、妆容、AI玩法…；可按推荐 / 最新 / 使用量排序，`next_cursor` 原样传回翻页）、按作品名搜索（默认搜全部分类并合并去重，每条带 `found_in`；`queries` 一次搜多个词；按 `offset` 分页，结果缓存 10 分钟） |
| `works_by_effect` | 按特效 ID 查排行榜等处的特效在首页有没有工程（一次最多 20 个），逐个返回 `found` / `same_style`（移动版「做同款」指向的首页工程，常是别人的另一个特效，`same_style` 给出是哪个）/ `same_name` / `not_on_homepage` |
| `works_download` | 下载并解压完整工程（与首页点开作品同一流程，但不开窗口），返回工程目录和文件概况（`key_files` 只列工程文件、场景和脚本，其余贴图模型只给计数）；`dest` 给定时把工程放到该目录；同一窗口的下载自动排队 |
| `works_open` | 下载并在新窗口里按首页的方式打开（不弹版本升级提示，工程处于未保存状态），返回 pid 和 instance_id |
| `works_cleanup` | 删除下载过的作品（含 `dest`）；编辑器窗口开着的保留，其它路径一律拒绝 |
| `icon_set` / `icon_open` | 把一张图片裁成 360×360 PNG 设为工程图标（默认女性、男性两版，提交窗口要这两个），并像「图标制作」窗口的「完成」一样上传到特效平台（提交窗口只认上传过的图标）；或打开「图标制作」窗口 |
| `effect_check` | 和工具栏「特效检测」按钮一样：打开特效检测窗口做云端检测（会上传特效包做测试，不是发布），等待结果，并读出检测页的详情一起返回（页面结论、每项结论、包体积和安卓 / iOS 帧率对上限、没通过的项的改进建议），然后关掉窗口；详情读不出时窗口留着并返回 `details_error`；超时时窗口留着，下次调用先关掉它 |
| `submit_prepare` | 本地检查包体上限、是否原样套用模板、登录、图标，通过后先关掉还开着的提交窗口（之前调用留下的），再走「提交特效」按钮的入口打开一个新的，逐页填写：名称（必填）、触发提示、默认摄像头方向、灵感、任务和赛道（可用 `icon_image` 先设图标），翻到「提交审核」页并等页面检测跑完，返回摘要、检测结果、协议是否已同意和 `next`（你还要做什么）。每一项都从页面读回核对，页面截断、报错、没选上或翻页被拦时报 `SUBMIT_*` 错误，窗口保持打开。不勾协议，也不点「提交审核」 |
| `submit_close` | 关掉开着的提交窗口，不打开新的 |
| `mobile_preview` | 按手机预览方式打包上传到抖音预览服务，返回和编辑器一样的二维码（7 天有效），抖音 App 扫码真机看；二维码同时存成文件（`~/.xiangsu-mcp-ext/mobile-qr/`），到期自动删除 |
| `inspiration_list` / `inspiration_detail` | 灵感分页列表（每页带上全部分类，每条带关联热点）、详情（说明、图片、奖励、关联热点的热度和标签、同灵感特效、示例视频的播放地址和封面、贴纸、是否已收藏）；关联工程服务端只给标题，没有 id，要下载就拿标题去 `works_search` |
| `inspiration_collect` | 收藏或取消收藏灵感（写账号），之后重新查询确认生效 |
| `inspiration_collected` | 当前账号收藏的灵感（按收藏时间从新到旧分页），字段同 `inspiration_list`，另有收藏时间、作品类型和所属征集任务；`submit_prepare` 的 `inspiration` 就在这些收藏里选 |
| `inspiration_bind` | 把灵感绑定到当前工程，提交时带上；提交窗口只列已收藏的灵感，没收藏的会顺手收藏 |
| `tasks_list` / `task_detail` | 活动中心的活动和特效征集任务的列表（按 `offset` / `count` 分页）与征集任务详情（状态和状态说明、奖励、整理过的任务说明：每个内容块的条目、参考图和视频引用、奖项金额和名额、链接，`save_to` 另存原始返回；征集任务详情还有自己提交到这个任务的特效 `my_effects`：审核状态、拍摄 / 播放 / 投稿峰值、获奖金额、任务评定 `task_state`（`pending` / `unfinished` / `done`）和是否被标「主题不符合」`off_theme`） |
| `growth_tasks_list` / `growth_task_detail` | 活动中心的成长任务列表（奖励、参考工程，分页）与详情（参考工程、相关灵感、教程） |
| `growth_route` | 移动版「成长之路」：当前特效师等级，每一级的奖励、状态和目标进度（如「绑定灵感上线 0/3 个作品 ¥10」），最高级的权益 |
| `task_receive` | 领取一个待领取（`WAIT_RECEIVE`）的征集任务（写账号，不能撤销），其它状态直接拒绝；领完自动重读任务列表，接着就能 `task_bind` |
| `task_bind` | 已领取的任务按任务详情页「去创作」的方式重开工程绑定；这个工程是唯一的窗口时，先开一个不保存的空工程当跳板，绑完关掉 |
| `rank_list` | 分页读移动版排行榜（榜单和筛选项写在参数说明里），可按日期、每级一个分类、特效等级、面板、偏好、来自工具、年轻喜爱度过滤；每页带上该榜当天的两级分类（大类如人像美化、细类如美妆） |
| `rank_hotspots` | 热点榜（按 `offset` / `count` 分页） |
| `hotspot_inspirations` | 一个热点下的灵感，按热点页页签的顺序分页，每条标出页签 |
| `douyin_hot_list` | 抖音实时热点榜（约 5 分钟一版）前 20 条：名次、名称、分类（娱乐、站内玩法、话题互动、二次元等）、热度 |
| `douyin_hot_detail` | 一个抖音实时热点的上榜时间、近 7 天每天和今天每小时的热度、站内已有的特效数（「上线特效0个」说明还没人做） |
| `douyin_hot_videos` | 一个抖音实时热点下的视频（接口原样顺序，不按热度）：播放地址、封面、点赞、作者昵称，分页 |
| `baidu_hot_list` | 百度热搜榜：置顶条和 50 条热搜（分页，默认前 20 条），每条有摘要、热度、配图、链接（不用登录、不用开像塑） |
| `bilibili_popular` | B 站「热门」视频：标题、链接、封面、分区、UP 主、播放 / 点赞 / 评论 / 弹幕、上热门的理由，分页（不用登录、不用开像塑） |
| `bilibili_hot_search` | B 站热搜词和热度（不用登录、不用开像塑） |
| `rank_subjects` | 专题合集里按主题的特效榜（`kind=effect`，如「热爆美妆特效榜」「熊出没IP特效榜」）和模板榜（`kind=template`，如「歌词玩法模板榜」），按 `cursor` 分页 |
| `rank_subjects_search` | 按榜名在专题合集全部期里搜索 |
| `rank_subject_detail` | 一个专题榜的全部特效 |
| `rank_innovation` | 创新计划官方精选（`kind=template` / `effect`）；同页重复的特效合成一条、标签合并，服务端翻页会出现上一页的特效 |
| `rank_creators` | 创新计划创作者月榜（头像给短引用） |
| `my_effects` | 自己提交过的特效，最新的在前：审核状态、绑定的任务和灵感、能否编辑 / 申诉；审核未通过、测试未通过、申诉审核未通过的带上最近一条审核记录（去掉标记的原因正文、分条原因、链接） |
| `my_effect_reviews` | 一个自己的特效的完整审核记录：「上线审核」和「精选审核」两条时间线 |
| `my_effect_data` | 一个自己已上线特效的「作品详情」数据卡片（要 `effect_id` 和 `app_effect_id`，都在 `my_effects` 里）：各 App 的上线状态和投稿、用到的功能、累计曝光 / 投稿 / 播放 / 跟拍、平台判定的特效类型、等级、年轻喜爱度、流量状态、播放数、绑定的任务和灵感 |
| `my_effect_trend` | 同一个特效近 7 日或上线后的按天曝光和投稿，投稿等级和升级还差的投稿 |
| `my_effect_revenue` | 同一个特效的收益明细（基础等级奖、年轻奖、跟拍奖、精选奖，各带说明） |
| `my_profile` | 账号资料：昵称、粉丝、特效作者 / 模板作者等级，「我的」页数字（开拍、播放、本月提交 / 上线、收入），本月数据 |
| `my_revenue` | 钱包收益：累计和某个月的总额、按来源、按天 |
| `messages_list` | 移动版「消息」页的站内信（全部 / 服务 / 官方），每条的标题、正文、时间、是否已读、审核状态和对应的 `effect_id`、链接，按 `cursor` 翻页 |
| `my_task_status` | 一次列出所有已领取任务里自己的作品和任务评定（`task_state`、`off_theme`），并按评定计数 |
| `effect_detail` | 任意已上线特效或模板的详情（按 `app_effect_id`，别人的也行）：等级代码、累计投稿 / 点赞 / 评论、喜爱度、男女比例、受众、风格、平台判定的类型、来自哪个工具、流量状态、用到的编辑器能力 `functions`、作者及等级、几条示例视频（图标和视频给短引用） |
| `effect_videos` | 用一个特效拍的热门抖音视频（标题、作者、点赞、跟拍、抖音视频 ID、封面和视频引用）和累计点赞、跟拍 |
| `effect_search` | 移动版搜索：按关键词搜全平台已上线的特效（最多 100 条）或模板（`kind`），按 `cursor` 翻页，每页最多 20；顺序是服务端定的（偏向累计投稿高的老特效），接口不认排序参数 |
| `inspiration_search` / `tutorial_search` | 移动版搜索：按关键词搜灵感、官方教程（字段同 `inspiration_list`、`tutorials_list`） |
| `tutorials_list` | 官方教程：全部分类（特效、模板两组）和一个分类或全部教程（标签、学习人数、飞书文档链接（要登录，读不到正文）、视频引用），按 `offset` 分页 |
| `shoot_activity` | 本期「拍视频激励」活动：起止时间、本期拍摄数、任务和完成次数、连续创作打卡每档的目标和奖金、新手成长任务的进度 |
| `shoot_scripts` | 官方拍摄脚本（教你用特效拍什么视频，带完整做法、播放数和拍摄数、示范视频引用），按标签代码筛选、按 `offset` 分页 |
| `music_categories` | 抖音音乐库的分类 |
| `music_list` / `music_search` | 一个分类的歌、按关键词搜歌（带版权标记），按 `cursor` 翻页 |
| `music_apply` | 按音乐库「使用」套用一首歌，可截取片段 |
| `scene_tree` | 场景结构的缩进文本：渲染组、对象 guid、名称、是否隐藏、组件类型；可只看子树（按 guid、名称或层级路径找，重名时列出候选）、控制层数。传 `project_dir` 时不开窗口，直接读工程的 `Assets/main.scene`（如 `works_download` 下载的作品），对象写成 `#序号` |
| `inspect_many` | 一次查看多个对象（guid、名称或层级路径）的组件参数，可按组件类型、属性名片段过滤，`{type, data}` 包装直接展开，绑定的资源和对象换成名称，妆容层的混合模式编号旁边写上名称；`preset="key"` 只留关键参数（变换、显隐、强度/不透明度/Transparency/颜色类、AI 脸 Channel、内部含强度类参数的整块参数如后处理发光、文字内容、绑定、脚本参数），并丢掉空贴图槽和完全透明的黑色。同样支持 `project_dir` |
| `makeup_layers` | 读工程目录里的全部美妆层（妆容层、旧版 `FaceMaskDY` 妆容层和美瞳），逐层给出区域、部位、混合模式、平均色、着色、贴图色乘着色的 `tinted_color`（没有实测核对）、男女强度和实际生效的不透明度（单独加的层：面板不透明度 × 男女强度 × 外部强度；整套美妆子项由 AI 脸接管，只按男女强度 × 外部强度）、表面质地（水润、珠光等）、只作用于哪几张脸、是否生效；部位先看层名，看不出时按贴图像素和混合模式判断（滤色等只会提亮的层归为高光）；整张不透明的贴图按离「不改变皮肤」的颜色多远算颜色和范围。`texture_source` 标出贴图是官方素材包（带 `package_id`）、作者导入还是副本。`sets` 列出整套妆（AI 实时变脸）各管哪些层，这些层带 `in_set`：删掉或关掉其中一个整套都会消失，只能把强度调成 0。`groups` 按底妆、眉、眼妆、美瞳、颊、轮廓、唇汇总，`absent` 列出整套妆没有的部位 |
| `makeup_compare` | 在同一张脸上比较几种妆容状态（关掉某层、男女强度、面板不透明度，或任意组件的数值属性如 AI 脸 Transparency、发光强度）：重置预览后截基线、逐个实时套上改动截图并改回、最后再截一次基线核对画面没变。要用静态照片做的模特视频；区域可以按画面比例给，也可以给 `eye` + 标定文件。可传 `reference` 参考图，区域带 `ref` 框时每种状态另给相对参考的差值，并排图末格是参考。每个区域返回平均色、亮度、皮肤细节及差值，并排放大图（不插值，一行放不下时换行） |
| `makeup_calibrate` | 量出妆容贴图在当前模特脸上的位置：临时加一个贴着「颜色即坐标」标定贴图的妆容层（面板不透明度设成 1，新建层默认 0.5 会和皮肤混色），另拍一张灰阶条纹量出预览的色调曲线、先反算再解码，截图期间其它妆容和滤镜强度临时调成 0，解码出每个画面像素对应的贴图坐标；返回标注图（贴图 y 等高线、x 刻度）、贴图格点落在画面上的位置，眼部布局另给每只眼上眼皮边和上眼缘最暗处的贴图 y。跑完改回所有强度、删掉临时层和标定贴图 |
| `preview_frames` | 按间隔连续截取预览，720×1280 原始分辨率（官方截图是 320×569），取自渲染结果，窗口在后台或最小化时也能截；默认先重置预览并等到重载后的画面再计时，截图期间临时恢复正常帧率（后台窗口平时 6 fps）；可依次换几个预览视频各截一组、截完切回（等编辑器把视频写回工程，原来干净的工程截完仍是干净的），可按比例裁出局部；每帧存成文件并返回，默认 24 小时后删除。这些截图 / 标定 / 对比工具都可传 `save_to` 把结果另存到目录长期保留 |
| `preview_videos` | 预览视频名，按 `tracking_type` 分组，外加当前视频；只给名字，挑 `preview_frames`、`makeup_compare` 的 `videos` 用（官方 `list_preview_videos` 约 70 KB） |
| `menu_list` / `menu_add` | 「添加对象」菜单项列表（`total` 是命中数，`menu_total` 是菜单总数；`details=true` 时带说明和示意图，一次最多 8 项）、按菜单项添加（可撤销）；云端 AI 生成项不暴露（AI 组合效果用下面两个工具） |
| `ai_combine_new` | 新建一张「AI 组合效果」工作流，等同 AI 效果窗口的「新建工作流」：本地建 AI Graph，只有「输入图」「效果组合」两个节点且未连线，不联网、不扣额度、不建云端草稿；返回 `ai_graph_id` 和各节点的 `node_id`（与官方 `get_workflow_context` 的节点 ID 相同） |
| `ai_combine_apply` | 把一张 AI 工作流放进场景，等同「应用」（可撤销）：编辑器编译工作流、上传工作流文件，再添加「AI 组合效果」对象（没有 2D 前景时一并建「2D 前景」「2D 摄像机」）；不扣额度、不建草稿，生成过预览视频时一并上传供审核；编辑器拒绝时返回它的提示原文（如「请先连接效果组合器」）；返回新增对象和 `draft_id` |
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
| `face_warp_list` / `face_warp_set_intensity` | 列出塑型画笔、改强度（保留笔刷数据，可撤销） |
| `object_remove` | 删除对象（可撤销），报告只被它使用的资源和它导入时带来的素材包文件夹；`delete_unused_resources=true` 时一并删除 |
| `resource_delete_unused` | 删除 `object_remove` 报告的路径；场景仍在引用的一律拒绝 |

使用顺序示例：

- 套用官方素材：`library_search` → `image_view` 看 `cover_ref` → `library_apply` → `capture_preview` → `save_project`。
- 读别人的工程：`works_search`（或 `works_list`）→ `image_view` 看 `cover_ref` / `gif_ref` → `works_download` → 按返回的 `outline.key_files` 读 `effect.dyehpj`、`Assets/` 下的场景和 `Graph/` 下的脚本 → `works_cleanup`。
- 在编辑器里看别人的效果：`works_open` → `get_scene` / `capture_preview` → `project_close`（`discard_changes=true`）→ `works_cleanup`。
- 交付：`icon_set` → `effect_check` → `mobile_preview` 真机看 → `save_project` → `submit_prepare`（`name`、`trigger_hint` 等），检查返回的摘要和 `next`，在窗口里点「提交审核」。要参加任务的，`tasks_list` → `task_receive` → `task_bind`，或者直接在 `submit_prepare` 里传 `task`。
- 找热梗：`douyin_hot_list` 看抖音正在火什么（分类「站内玩法」多是梗和跟拍玩法）→ `douyin_hot_detail` 看热度是在涨还是在落、站内有没有人做过特效 → `douyin_hot_videos` 看实际怎么拍；站外话题用 `baidu_hot_list`、`bilibili_popular`、`bilibili_hot_search`；梗的出处和用法用联网搜索查。
- 找选题：`rank_list`（如 `rank_type=1` 年轻喜爱榜、`categories=["人像美化","美妆"]`、`levels=["S","A+"]`）看什么在火；`rank_subjects_search`（`keyword="测一测"`）或 `rank_subjects`（`kind="template"`）看各期主题榜，`rank_subject_detail` 看一个榜的全部特效；`rank_hotspots` → `hotspot_inspirations` 看热点灵感 → `inspiration_detail` → `image_view` 看图；`tasks_list` → `task_detail` 看征集要求和奖项 → `image_view` 看内容块里的参考图。
- 看榜上特效的工程：`rank_list` → 把这页的 `effect_id` 和 `name` 交给 `works_by_effect` → `status=found` 或 `same_style` 的用返回的 `template_id` 走 `works_download` / `works_open`（`same_style` 下载到的是 `same_style` 里那个特效的工程，不是榜上这个特效本身的）。
- 拆别人的爆款：`rank_list` 或 `effect_search`（如「美妆」）→ `effect_detail` 看受众、平台判定的类型和用了哪些编辑器能力 → `effect_videos` 看别人怎么拍、标题怎么写（`image_view` 拿视频地址）→ `works_by_effect` 找能下载的工程。
- 学做法：`tutorials_list` 看官方教程分类，或 `tutorial_search` 按关键词找；拍视频推作品用 `shoot_activity` 看本期激励任务，`shoot_scripts` 看官方拍摄脚本。
- 查审核结果：`my_effects` 看哪些没过、`review.text` 是原因 → 要看整条时间线用 `my_effect_reviews`；`can_edit=true` 的在编辑器「拍摄特效管理」里点「编辑」改完重新提交。
- 看作品表现：`my_effects` 拿 `effect_id` 和 `app_effect_id` → `my_effect_data` 看曝光和数据卡片、`my_effect_trend` 看按天趋势和离下一级还差多少、`my_effect_revenue` 看收益；账号用 `my_profile`，收入用 `my_revenue`；上线、精选、获奖等通知用 `messages_list`；交了哪些任务、评定如何用 `my_task_status`。
- 拆别人的妆：`works_download` → `makeup_layers` 看用了哪些部位、什么颜色、多浓；自己的工程 `save_project` 后同样用 `makeup_layers` 查缺了哪些部位。
- 复刻妆面：`library_search` / `library_apply` 套官方整套 → 换单品、调 `female`/`male`/`intensity` 和 AI 脸 `Transparency` → 官方给不了的形状在官方模板图上自绘 PNG，用 `edit_by_dsl`（`duplicate_scene_object` + `import_resource` + `set_component`）挂层 → `makeup_compare`（可对参考图）/`preview_frames` 验收 → `save_project`。
- 调强度：`makeup_compare` 在同一张脸上比「关掉这层」「0.3 / 0.6」、面板不透明度、AI 脸 Transparency 等，看眼下、脸颊等区域的亮度和颜色变了多少。
- 做 3D 角色：官方 `generate_image`（正面全身、纯色背景）→ `ai3d_image_submit` → `ai3d_tasks`（`task_id` + `wait_s`）→ `ai3d_import` → `capture_preview` 调大小和位置 → `save_project`。图生 3D 的模型没有骨骼，动作用脚本驱动；要用视频里的动作，模型须带标准人形骨骼（如 Mixamo 绑过骨、去掉 `mixamorig_` 前缀），走 `ai3d_animation_submit`。
- 做 AR 视频贴片：官方 `generate_image`（主体正面全身、纯色背景）→ `ar_video_submit`（`mode=motion`、`prompt`）→ `ar_video_tasks`（`task_id` + `wait_s`）→ `image_view` 看 `preview_image_file` → 满意再 `ar_video_import` → `capture_preview` → `save_project`。
- 做 AI 组合效果：`ai_combine_new` → 官方 `get_workflow_capabilities`（选生图基模）→ `apply_workflow_patch`（加生图节点、写 prompt、连「输入图 → 生图 → 效果组合」）→ 要看效果时官方 `generate_workflow`（扣额度）→ `ai_combine_apply` → `save_project`。别人的作品怎么搭的，用 `works_download` 下载「AI玩法」分类里的工程，看 `Assets/AI 组合效果/*.oAICombineTextureJSA` 里的 `workflow` 和 `Graph/graph.json` 里的 AI Graph。

相近工具的分工（每个工具只做一件事，这些也写进了工具说明；和官方工具重叠的，在官方工具的说明末尾补了一句指向这里）。判据：一个参数会让工具换成另一种查询或操作（列表和详情、榜单和搜索、两张不同的页面卡片），就拆成两个工具；只是缩小范围的筛选（分类、分页、排序）留作参数。

- 看场景：`scene_tree` 先摸清结构（紧凑文本，也能读下载的工程目录）→ `inspect_many` 一次看多个对象的参数；要完整 JSON 才用官方 `get_scene` / `inspect`。
- 删对象：只删对象用官方 `edit_by_dsl`；要知道删完哪些资源没人用了、连带清理，用 `object_remove`（→ `resource_delete_unused`）。
- 绑灵感：`inspiration_bind` 按 ID 写进工程，提交窗口自动带出；只在提交时选，给 `submit_prepare` 传 `inspiration`（在收藏的灵感和热点里按名称选）。
- 绑任务：`task_bind` 重开窗口把任务写进工程；只在提交时选，给 `submit_prepare` 传 `task`，不用重开窗口。
- 成长：`growth_tasks_list` 是活动中心里一个个成长任务（参考工程、教程），详情用 `growth_task_detail`；特效师等级和每级目标进度看 `growth_route`。
- 素材库：知道要找什么用 `library_search`；按面板和子分类浏览用 `library_list`。
- 搜特效：要能下载的工程用 `works_search`（只搜首页作品）；要看全平台已上线特效的数据用 `effect_search`，再用 `works_by_effect` 找工程。灵感按分类翻用 `inspiration_list`，按关键词搜用 `inspiration_search`；教程同理（`tutorials_list` / `tutorial_search`）。

几点约定：

- `library_apply` / `library_images` 只接受本会话里 `library_list` / `library_search` 返回过的 `template_id`；`works_download` / `works_open` 只接受本会话里 `works_list` / `works_search` / `works_by_effect` 返回过的作品（记录在 MCP 服务里，不受工程窗口开关影响，重启服务后需重新搜索）。
- 像塑最多同时开 2 个工程窗口（编辑器的 `CHILD_PROCESS_LIMIT`）。都占满时 `project_open` / `project_new` / `works_open` 返回 `WINDOW_LIMIT`（首页进程答复 `reuseCurrent`，工具不会把工程换进当前窗口），先 `project_close` 一个。刚 `project_close` 完名额要过几秒才释放，开窗遇到 `WINDOW_LIMIT` 会每秒重试、最多 8 秒；仍失败时报错列出占着名额的窗口。`works_open` 在下载之前先查名额，满了直接拒绝。
- 素材的 `kind`：`package` 素材包、`ai_image` AI 图片、`ai_makeup` AI 妆容（按部位建多个对象）、`custom_gan` 自定义实时变脸、`foreground_sticker` / `face_sticker` 图片贴纸、`filter` 滤镜。素材广场里没有可应用内容的卡片（编辑器点应用也没反应）不列出，只在 `unsupported` 里计数。素材广场单个关键词最多返回 1000 条。广场卡片是异步应用的，工具等对象出现在场景里（最长 60 秒）才返回；新建的渲染组（如「2D 前景」「AI 实时变脸 (1)」）会作为新增对象报告，删除它们用官方 `edit_by_dsl` 的 `delete_render_group` 命令。
- 素材库的搜索接口只匹配标题，很多素材的名字里没有人们会搜的词（美妆 › 腮红里是「雾堇胭」「红玫瑰」，没有素材叫「滤镜」），所以 `library_search` 还会展开名字与搜索词相同的面板或子分类，以及「子分类 + 面板」组合（「复古滤镜」）；「面板 + 其它词」（「韩系滤镜」）只在该面板里按标题搜「韩系」。名字只是包含搜索词的子分类不展开，列在 `related_categories`。每个面板或子分类最多取 300 条（实测子分类 17–125 条）。什么都没匹配到时返回 `hint`。
- `works_*`、`inspiration_*`、`task_*`、`rank_*`、`my_effects`、`my_effect_reviews`、`my_effect_data`、`my_effect_trend`、`my_effect_revenue`、`my_profile`、`my_revenue`、`messages_list`、`my_task_status`、`effect_detail`、`effect_videos`、`effect_search`、`inspiration_search`、`tutorial_search`、`tutorials_list`、`shoot_activity`、`shoot_scripts`、`library_list` / `library_search` / `library_images`、`menu_list` 与当前工程无关，任意一个工程窗口开着即可；不指定工程时由 pid 最小的窗口处理。
- 返回资料的方式：
  - 列表默认每页 20 条（服务端上限更小的按上限），只给挑选时要看的字段；要细节用对应的详情工具。
  - 列表里的图片、视频、音频不给地址，给短引用 `*_ref` / `*_refs`（`img:12`、`video:3`、`audio:5`），交给 `image_view`：一个签名 CDN 地址有几百字，实测占列表每条的 43%–93%。引用记在 MCP 服务里，这次运行期间有效（最多记 2 万个，超出时忘掉最久没用的）；详情工具（`inspiration_detail`、`menu_list` 的 `details`）给的是这个对象自己的图，仍给地址；`effect_detail` 的图标和视频是签名长地址，也给短引用。
  - 我们自己的工具回答超过 3 万字时，全文写进 `~/.xiangsu-mcp-ext/outputs/`（24 小时后删除），回答换成文件路径和结构概要（每个字段的值或条数，列表给每条有哪些字段），用读文件的工具按需读，或用分页参数分几次取。3 万是拍的：`task_detail` 原来一次回 4.8 万字，读不全。官方工具原样转发，不受影响；只有官方报错超过 4000 字时（如 `apply_workflow_patch` 校验失败的整段展开）截断，全文写进同一目录。
  - 字段命名：投稿量统一叫 `publish_*`（`publish_count`、`publish_peak`、`publish_total`），跟拍量叫 `follow_shoot`，页面原样给的展示文字（如「1.2万」「¥50」）以 `_text` 结尾，换算过的金额以 `_yuan` 结尾；看不出单位的数（任务奖项的 `money`、`award_amount`）原样给，不换算。
- 灵感、任务、排行榜按编辑器首页活动中心的方式请求（编辑器的登录 Cookie 和签名请求头），读写的都是编辑器里登录的账号。排行榜和成长之路用的是像塑移动版的接口，榜单名和筛选项取值与移动版一致，后端改版时可能失效。灵感和任务详情的接口移动版和编辑器是同一个（2026-11-08 对照移动版 v17.7.0 安装包里的接口逐个实测，返回完全相同），移动版看到的内容都在工具的返回里；热点内容流、任务筛选、每日任务、创新任务这几个移动版接口暂未接入（参数未知，或当前账号没有内容可核对）。
- `inspiration_collected` 用的是首页灵感页「收藏」页和提交窗口灵感下拉共用的 `/creator_api/inspiration/v1/collect_list`（参数取自两个页面的在线脚本，2026-11-10 实测）：不带作品类型 `artwork_types` 时一条都不返回；灵感页只要 0（特效）和 5（表情），提交窗口要 0、5、14，而当前账号还有一条类型 2（模板）的收藏，两个页面都列不出来，所以工具带上 0、2、5、14（试过 0–20，只有 0 和 2 有内容）。别的类型的收藏要是出现，工具也会漏掉。
- 作品数据、账号和消息（`my_effect_*`、`my_profile`、`my_revenue`、`messages_list`）的参数取自移动版 v17.7.0 安装包反编译出的 Dart 代码，2026-11-09 用自己的账号逐个实测：作品详情的接口都要 `effect_id`、`app_effect_id` 和 `app_id`（抖音是 184），只给其中一两个时服务端答「参数错误」；数据趋势的 `cycle` 是页面「近7日」「上线后」两个标签的序号加 1，其它值答「参数不正确」；消息按上一页最后一条的 ID 翻页。趋势里按天的曝光和投稿是逐日累计值，数据隔天才更新。等级是数字代码，接口不给对应的字母；投稿门槛以移动版「激励规则」页为准。作品详情里的 `tips` 和 `scarce_category` 两张卡片对试过的特效都没返回内容，有内容时原样放在 `unread`。
- 特效详情、视频、搜索、教程、拍视频激励和拍摄脚本（`effect_detail`、`effect_videos`、`effect_search`、`inspiration_search`、`tutorial_search`、`tutorials_list`、`shoot_activity`、`shoot_scripts`）的接口取自移动版 v17.7.0 安装包，2026-11-09 实测：特效详情的接口不带 `effect_source` 时答「请求参数错误」，带 0、1、2、3、5、6 都返回同一个特效，返回里另有它真实的来源，所以工具固定带 1；不存在的 ID 答 `code=3000`（「特效不存在」）。同一个特效连查几次，`project`（用到的编辑器能力）、`designer`、平台判定的类型和点赞评论数这几块时有时无，缺的给 `null`。等级 `level_code` 是另一套数字（年轻喜爱榜第一的特效是 25），和排行榜的字母等级对不上。视频接口的「优秀视频」和「作品视频」实测是同样 5 条，前者多了抖音视频 ID 和没截断的标题，工具按视频地址合并成一个列表。搜索每页超过 20 条答 `code=1014`；特效最多翻到 100 条（翻到底核对过），模板和灵感返回的 `total` 是 300（没有翻到底核对）。教程不传分类时返回全部 188 篇，比 13 个分类之和（172）多；文档教程的 `link` 是飞书文档，不登录访问会跳到飞书登录页，agent 读不到正文，视频教程的视频是 CDN 地址，能直接打开。拍摄脚本共 48 条，App 里没有标签名，标签代码按各标签下脚本名的【】前缀归纳（写在 `shoot_scripts` 的说明里）。「拍视频激励」里每个作品能否参加的列表（`/cam_api/activity/v1/effect_list`）没有做成工具：按「未拍摄」筛选返回 0 条，而每个作品的拍摄状态又都是 0，含义对不上。
- 几处上限是在服务端实测的：`rank_list` 和 `rank_subjects` 每页最多 20、`inspiration_list` 每页最多 50（100 会报错）、`inspiration_collected` 每页最多 50（传 100 也只回 50）、专题榜详情一次最多 20。移动版的「特效优秀视频榜」接口对所有榜单都返回空，没有提供。
- 审核记录：编辑器的「拍摄特效管理」（`/creator/v1/effect_list`）只有状态码，原因在像塑移动版的审核记录页（站内信「点击查看未过审原因」打开的 `effect.douyin.com/m/detail?showReviewList=1`）。工具按那个页面的方式取：「上线审核」先读 `review_nodes`（`review_type=1`），没有记录再读 `effect_reviews`；「精选审核」读 `review_nodes`（`review_type=2`）。2026-11-07 实测，被驳回的特效 `review_nodes` 不返回记录，原因来自 `effect_reviews`，如「特效不符合规范：特效中可能含有涉及展示或宣扬不同群体攻击对立类内容」。正文里的 `|<b>…<b>|`、`|<a><href>链接<href>文字<a>|` 等标记按页面的规则去掉，链接放进 `links`。分条原因 `refuse_reasons` 的结构取自页面代码，实测的特效还没带过。别人的特效和不存在的 ID，服务端一律报 `code=1301`（「参数不正确，请正确访问」）。
- `my_effects` 翻页要把上一页返回的 `sort` 原样传回，`next_cursor` 就是它（传 `cursor` 或 `offset` 都只会拿到第一页，2026-11-07 实测）。服务端不给「还有没有」，工具按「这页满了就还有」判断，所以最后一页正好满页时 `has_more` 仍是 `true`，再翻一页得到空列表。每页上限 50 是拍的：每个未通过的特效要多一到两次请求。
- 只有作者分享到首页的特效才有工程可下载。排行榜的 `effect_id` 和首页作品的 `effect_id` 是同一套编号，`works_by_effect` 按 ID 精确匹配（与首页搜索框的「特效ID」搜索同一个接口，默认在「推荐」里查，首页在「官方工程」里不提供按 ID 搜）。按 ID 搜时「推荐」也能查到只出现在其它分类的作品（2026-11-07 实测 8 个全中，在它们自己的分类里按 ID 搜反而一个都查不到），所以不用跨分类查。
- 首页翻页除了 cursor 还要带上一页返回的 `sortingPosition` 和 `version`（编辑器首页就是这样翻的），只带 cursor 每一页都是第一页；`works_list` 的 `next_cursor` 把三者编在一起。按作品名搜索时，「推荐」翻到底只有约 300 条，「美化」「友友天地」等分类里还有它没有的（「头套」多 46 条、「美妆」多 87 条），所以 `works_search` 默认搜全部分类。服务端偶尔会提前结束一轮翻页（6 轮里有 1 轮停在 249 条），没到 300 条上限的分类会再翻一轮合并；服务端一直给同一页时停下，并把分类列在 `incomplete`。结果分四种：`found` 首页有这个特效的工程；`same_style` 首页没有它，但移动版特效详情页的「做同款」按钮（`/cam_api/feed/v1/get_item_project`）指向首页上的一个工程：接口给出 `guide_project_info.id`（就是首页的 `template_id`）和它所属特效的 `project_id`、`project_name`，工具按这个特效 ID 在首页查到那个作品，它常是别人的另一个特效（「顶美精致淡妆感」指向「可可裸妆」，「你们两个最适合当什么」指向「好友对你都有什么想法」），不是榜上这个特效本身的工程；`same_name` 首页没有它、也没有做同款工程，只有同名作品，`effect_id` 不同，可能是别人的作品，不能当成同一个特效；`not_on_homepage` 拿不到工程（编辑器「我的特效」里的工程下载只对自己的特效开放）。做同款工程在首页查不到时，`same_style` 字段照样给出，`status` 按同名作品的查找结果。每个特效一到四次请求。2026-11-07 实测年轻喜爱榜第一页 20 个特效：10 个 `found`，1 个 `same_name`，9 个 `not_on_homepage`；2026-11-09 加上做同款后再测当天第一页：7 个 `found`，9 个 `same_style`，4 个 `not_on_homepage`，20 个用了约 8 秒。
- 提交窗口是抖音特效平台的网页（`effect.douyin.com/ac/submit-orion`，每次在线加载，安装包里的离线版本较旧，字段也不同）。`submit_prepare` 按页面上的类名和文案找元素，页面改版后找不到时报 `SUBMIT_PAGE_CHANGED`，不会跳过。名称框会在页面的 `aiName` 配置请求回来时重新挂载，先填的内容会被清空（2026-11-07 实测，配置在表单出现约 1 秒后才回来），所以工具等这个请求完成再填，最后再用「提交审核」页的摘要核对一遍。灵感下拉只列当前账号收藏的灵感和热点，每次加载 10 条，不在列表里的用页面的搜索框找；选了和灵感所带任务不一致的任务时，页面会清掉灵感，工具会报 `SUBMIT_BINDING_NOT_APPLIED`。「特效发布设置」页上按账号出现的其它设置（活动、创新声明、作品授权）不填，列在 `other_sections`。
- `works_download` / `works_open` 走编辑器自己的下载流程，每次解压一份新的到像塑实例目录的 `ProjectCreatedTmp/CreatedFromTemplate/<guid>/` 下。`dest` 副本不含 `Library/` 缓存（编辑器打开时会重建）。
- 下载物不留痕：
  - 编辑器缓存在 `~/Library/Application Support/DouyinAR/Shared/Resources/LokiDownload/TemplateResources/` 的工程包，解压后立即删除（下载前已存在的视为你自己在首页用过的缓存，不动）。
  - 给了 `dest` 时，临时目录里那份随即删除。
  - 每份下载（临时目录或 `dest`）登记在 `~/.xiangsu-mcp-ext/works-downloads.json`。`works_cleanup` 随时删除；没删的在 24 小时后由下一次下载自动清掉（这个时长是拍的：够一个工作日内学完，又不至于堆积，可按需调 `src/works.mjs` 的 `DOWNLOAD_TTL_MS`）。
  - 编辑器窗口正开着的下载不会被删；像塑关窗时不会自己删除这些目录，关窗后再调 `works_cleanup`。
- AI 组合效果在工程里由三部分组成：场景里的「AI 组合效果」图片对象、它绑定的组合效果纹理（`Assets/AI 组合效果/*.oAICombineTextureJSA`，存编译好的 `workflow`、上传后的 `graphTosUri` 和云端草稿 `draftId`），以及 `Graph/graph.json` 里的 AI Graph。「添加对象」菜单里的 AI 组合效果只建对象和一张 `workflow` 为 `{}` 的空纹理，编辑器自己也是先建空壳、再由「应用」填参数，所以 `menu_add` 仍然拒绝它，改用 `ai_combine_new` / `ai_combine_apply`。哪些步骤会连到云端（2026-11-08 读编辑器代码；`ai_combine_new` 和 `ai_combine_apply` 不建草稿是实测，官方 Patch 建草稿、预览视频上传只读了代码，没有实测）：`ai_combine_new` 和本地连线都不联网；官方 `apply_workflow_patch` 每次改完都会把工作流存成账号下的云端 AI 效果草稿（`releaseAIEffect`），此后 `ai_combine_apply` 返回的 `draft_id` 就是这个草稿；官方 `generate_workflow` 扣生图额度；`ai_combine_apply` 上传工作流文件，生成过预览视频时把视频一并上传供审核，自己不建草稿。场景里有变声组件时编辑器拒绝「应用」，工具报 `AI_COMBINE_APPLY_NO_EFFECT`。
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
  - 限制取自编辑器：包括主体最多 9 张图、3 段视频，描述最多 2000 字，动作最短 4 秒；动作时长上限、输入视频总时长上限和投影默认值来自编辑器开关（`dyeh_ar_video_max_output_duration_s`、`dyeh_ar_video_max_input_duration_s`、`dyeh_enable_ar_video_shadow`），2026-11-08 读到的是 15 秒、15 秒、开。入口开关 `dyeh_enable_ar_video_entry` 没打开时（编辑器默认关）工具和面板一样不可用。
  - 一个窗口里面板同时只跑一个「当前生成」，其余在后台；工具提交后把自己的任务转到后台，所以可以连续提交，同时在跑的上限是 10 个。
  - 结果在提交它的那个工程窗口里合成；别的窗口第一次看到这个任务时要自己下载并合成一次（显示 `restoring`）。
  - 次数：编辑器只有用完时的提示「模型使用次数达到上限，请提升特效师等级以获取更多次数」（错误码 2038），没有查询剩余次数或单次消耗的接口。
  - 实测（2026-11-08，一次）：一张 1024×1536 的小猫图、`mode=motion`、10 秒、不加投影，云端 2 秒接受，约 6 分钟后在本机合成完，输出 720×720、24 fps、带原声。之后在另一个工程窗口里查这条任务，直接就是 `succeeded`（编辑器的生成记录缓存在 `Shared/Resources/ARVideoHistory/` 下，各窗口共用，本机合成的文件还在就不重做）。
  - 导入后的场景（同日实测，导进一个空场景）：渲染组「AR跟踪」›「AR平面跟踪」（`MeshRenderer`，内置 AR 平面网格和「蒙版阴影」材质）›「AR 视频主体 1」，加一个「AR摄像机」（`Camera`、`DeviceTracker`）；空场景还会多出「通用」组。「AR 视频主体」上有 `Image`（`texture` 是导入的 `Mp4Texture`「混合透明 MP4 播放器」，`loopCount=-1` 无限循环）、`LookAt`（朝向 AR 摄像机）、`AudioComponent`（原声，`autoPlay=false`）和编辑器内置的 `ARVideoAudioController`（`playOriginalAudio_target`、`originalVolume_target`、`videoTexture_target`，让原声跟着视频播）。脚本里控制视频：`texture.getControl()` 的 `play()` / `pause()` / `resume()` / `stop()`，事件用 `APJS.EventManager.getObjectEmitter(texture)` 监听 `APJS.Mp4Event.*`（取自内置节点「视频纹理播放器」的实现 `CGVideoTexturePlayer.js`）。同一个工程第二次导入时对象怎么排还没有实测。
  - 预览图 `preview_image_file` 是用编辑器自带的 ffmpeg 从预览视频均匀取 6 帧拼成的横条，存在 `~/.xiangsu-mcp-ext/ar-video/<task_id>.jpg`，预览视频重建后自动重做。
- 预览重载有延迟，应用后用 `interact_by_dsl` 先 `wait` 2–3 秒再截图更稳。
- 资源删除不可撤销；对象删除可以在编辑器里撤销，但已删除的资源不会回来。
- 「孤儿资源」只按场景直接引用判断（资源的编辑器 guid 是否出现在场景序列化数据里）。只通过材质等间接引用的资源不会被判为孤儿。
- 素材放进场景时，编辑器会按对象名再建几个文件夹（如 `复古清冷_滤镜`、`复古清冷_美妆`），保存时对象还在才会写到磁盘。`object_remove` 把这类只在编辑器里的路径单独列在 `editor_only_paths`，对象删除后下次保存就会消失，不用删；`unused_paths` 只含磁盘上真实存在的路径，可以照着删（用 `resource_delete_unused`）。

## 安装（macOS）

需要 Node.js 24+ 和已安装的像塑。安装即表示你同意下面「协议与声明」里的用途限制：只用于学习和个人制作，不得用来抄袭他人作品。

从 npm 安装（必须全局安装：插件按绝对路径加载这份代码，`npx` 的临时缓存会被清理，安装命令在那里会直接拒绝）：

```bash
npm install -g @muqian/xiangsu-mcp-plus
xiangsu-mcp-ext-install   # 装到 ~/Library/Application Support/DouyinAR/Plugins/v<版本>/Local
echo "$(npm root -g)/@muqian/xiangsu-mcp-plus/src/server.mjs"   # MCP 配置里 args 用这个路径
```

或从源码安装：

```bash
git clone https://github.com/Muqian-Sun/xiangsu-mcp-plus.git
cd xiangsu-mcp-plus
npm ci
node scripts/install.mjs
```

在 MCP 客户端配置里加一个 stdio 服务（`command` 用 `which node` 的绝对路径，`args` 用上面的 `server.mjs` 路径或源码目录下的 `src/server.mjs`）：

```json
{
  "mcpServers": {
    "xiangsu": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/src/server.mjs"]
    }
  }
}
```

它已经包含官方工具，不必再单独配置官方的 `xiangsu-mcp-manager`。如果你还在用像塑自带的 `xiangsu-effect-editor` skill，它要求客户端里存在名为 `xiangsu-mcp-manager` 的服务；这种情况下保留官方配置即可，两者可以并存。

插件只在安装后**新打开的工程窗口**里加载；已开着的窗口要保存后重开。插件直接 `require` 这份代码（源码目录或 npm 全局目录），安装后不要挪动；用 `npm install -g` 升级时路径不变，不用重新运行安装命令。

### 更新后怎么生效

- 改 `editor-plugin/library.cjs` 或 `editor-plugin/features/*.cjs`：插件在下次调用时按修改时间自动重载，不用重开窗口；改坏了返回 `LIBRARY_RELOAD_FAILED`，旧版本继续运行。新增插件方法写进对应 feature 的 `METHODS`。
- 改 `editor-plugin/runtime.cjs`：重开工程窗口。
- 改 `src/`：在 MCP 客户端里重启这个服务。

## 开发

- `npm test`：用模拟的编辑器模块测插件逻辑；用 jsdom 按线上结构搭的提交页测填写流程；用内存传输测 MCP 工具、官方转发、工程窗口编排。
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
- AI 3D：`AssetsLibrary/Core/Control/AI3DManager/{const,utils}`（场景名、模型 ID、缓存目录、结果文件路径）、`@orion/Business/API/ai_effect_api`（提交 / 查询 / 历史 / 取消）、`@orion/Business/API/upload_api`（`uploadFileCommon`、`uploadToSpace`）、`AIEffectWindow/controller/apiUtils.QueryTaskResult`（主体识别的轮询）、`Utils/LokiAsset/utils.downloadTemplateFile`、`ResItemExtraData/ResourceImportHandles`（`importExtAsset` + 加载回调）、`EditorFramework` 的 `APJS.FbxLoaderAPJSWrapper`（检查本地模型）和 `Extension.Scene.AssetSceneObjectCreationSystem`、`PreviewManager.checkIsValidVideoFile` / `getFirstNonBlackFrame`、`@orion/config/LegacyGlobalConfig.url`（内置模型的绝对路径；`orionui` 的 `url` 给的是相对路径）
- AR 视频：`AssetsLibrary/Core/Control/ARVideoManager/ARVideoManager`（面板的任务管理器，经 `AssetsLibrary.getInstance().arVideoManager` 取实例）、`VideoMatting/{ARVideoGenerationContract,ARVideoAudit,ARVideoAnalytics,ARVideoProject}`（限制与开关、审核状态、生成模式、导入）、`AssetsLibrary/Core/Control/AssetsLibraryNav/util.isARVideoEntryEnabled`、`Utils/Ffmpeg.ffmpegExec`（抽帧预览图）
- 工程窗口：`OpenProjectFromEditCommand` + `EditSender`（与编辑器自己的 `launchProject` 同一请求，9.8.1 起首页进程只认它），`closeProjectAndBackToHome`
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

Unofficial MCP extension for Douyin AR (像塑) on macOS. One stdio MCP server proxies every tool of the editor's official MCP (with automatic reconnects) and adds what the official server cannot do: browse/search/preview/apply official library assets, browse/search/download or open the homepage works (official projects and published effects) as full projects an agent can read and learn from (rank-board effects are looked up there by effect id, though effects whose authors did not share them on the homepage have no downloadable project; every download is registered and deleted by works_cleanup or after 24 hours), add any item of the editor's "add object" menu (toolbar makeup / reshape / AI face effects), create AI combine workflows (the photo is sent to the cloud and generated from the workflow) and apply them to the scene the way the AI effect window does, leaving node editing and preview generation to the official workflow tools, run the asset library's AI 3D generation (image → static mesh, a video's human motion → an animated FBX with the standard humanoid skeleton, an orbit video → a 3D Gaussian splat) and import the results the way its panel does, run its AR video generation (a subject image or video → a matted video of the subject doing a described motion, placed as an AR plane sticker) through the panel's own task manager, list a project's makeup layers with the face part, colour and strength of each (from the layer's region and its texture's pixels when the name says nothing), set FaceWarpX brush intensity, prepare delivery (setting and uploading the icon, local and cloud effect checks, filling in the submit window — name, trigger hint, camera, inspiration, task — up to its final step, where pressing 提交审核 stays a user click, phone preview QR codes, binding received creator tasks or inspirations), read the signed-in account's inspirations and tasks (collect inspirations, receive tasks) and the mobile app's rank boards, list the account's submitted effects with their review status and, for rejected ones, the reviewer's reason and full review timeline, use Douyin music, open/create/close project windows, and remove objects together with resources only they used. It works through a small editor plugin that exposes a token-protected RPC on 127.0.0.1 inside each project window. Relies on editor internals (verified on 9.7.2); `ext_status` reports any missing internals. Install with `npm install -g @muqian/xiangsu-mcp-plus && xiangsu-mcp-ext-install` (a global install is required: the editor plugin loads this code by absolute path, so the npx cache is refused), or from source with `npm ci && node scripts/install.mjs`; then register `node <package>/src/server.mjs` as a stdio MCP server.

**For learning and personal creation only. Do not use it to copy other creators' works**: works you view, download or apply through this tool (homepage projects, ranked effects, assets other creators shared) must not be republished, submitted, used commercially or passed off as your own, as is or modified. Licensed under [MIT](LICENSE), which covers this project's own code only. Not affiliated with or endorsed by ByteDance / Douyin; all product names and trademarks belong to their owners. The repository contains no editor code or assets. Official assets and homepage works accessed through this tool belong to 像塑 or their creators and are subject to the platform's terms; use downloaded works for learning only, delete them with works_cleanup when done, and do not redistribute them.
