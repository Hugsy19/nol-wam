# 项目长期约定（nol-wam）

## 目标

NOL World（原 Interpark 全球站）购票辅助工具，形态为 Chrome MV3 插件，位于 `extension/`。

## 硬性边界（不可协商）

- **不实现自动下单/自动选座/验证码识别**。韩国《公演法》第 14 条第 3 款禁止用自动程序
  （매크로）购买公演门票，属刑事罪名；NOL 公告亦明确 macro 订单会被取消。
- 只做「监控 + 提醒 + 定位」，最后的下单动作由用户人工完成。
  （用户已**三次**提出要"扫描到就自动锁定座位直到付款页"，均按此边界拒绝；
  第三次换了个说法——"模拟鼠标点击"，答案不变：**判定看谁完成购买动作，不看机制**。
  合成 MouseEvent / CDP 注入 / PyAutoGUI / 直接发接口，同属 14③ 的自动程序。
  席位锁定链路 `PreselectSeat` → `seats/select` 已完整记录在 `analysis/HAR-接口分析.md` 第 4 节，
  但**只在文档里留存，不写进代码**。）
- 轮询频率要**尊重站点限流**（官网基线：座位页 `seatStatus` 中位 3.8~4.6s，最快 2.6s）。
  插件默认 2800ms；v0.6 起下限放宽到 **800ms**（`MIN_INTERVAL_MS`），
  `INTERVAL_OPTIONS=[800,1000,1500,2000,2800]`，低于 `INTERVAL_AGGRESSIVE_MS`(1000) 时 UI 提示限流风险。
  用户明确要求过"间隔可以再小一点"，所以下限不再对着官网基线定，但要保留激进档提示。

## 选座会话 10 分钟倒计时（v0.6，核心机制）

- **`x-onestop-session` 末 10 位 = 排队放行那一秒的 Unix 秒**（结构 `{goodsCode}_M{userSeq 补零12位}{Unix秒10位}`，
  抓包实测与 `waiting/api/rank` 放行时刻误差 0.45s）。这就是倒计时锚点，页面刷新也不变。
- **时限 10 分钟来自站点语言包**：`locales/en/common.json` 的 `session_timer_expired_title`。
- **权威终点 = 页面自己在轮询的 GraphQL `ExpiredSession { isExpiredSession }`**；插件只读旁听（钩子已 WATCH `/onestop/gql`）。
- 判停规则在 `lib/session-timer.js`（纯函数）：服务端 true → 停；本地归零但服务端 60s 内说过 false → 45s 宽限；否则停。
  倒计时 UI **每秒只改文本节点**，绝不 `renderPanel()`（地图上万 SVG 节点）。

## 验证码关卡（v0.7，红线 + 实测数据）

- **实测（真实抓包时序）**：令牌尾数（计时起点）t+53.9s → `POST /onestop/api/captcha/image` t+79.3s
  → `GET /onestop/api/captcha/verify?p1=<答案>&…&p9=<签名>` t+87.7s → **人工全程 ≈8.3 秒**，占 600 秒的 1.4%。
- **不做**：不请求验证码、不 OCR、不代填、不代提交。verify 挂 **p9 签名**，代提交 = 重放整条购买链路；
  而这正是站点反机器人闸门 + 《공연법》14③ + NOL 封号条款的核心目标。为 8 秒冒账号级风险不划算。
  测试里有**合规自检断言**（无 OCR/无伪造输入事件/无主动请求/输入框只 focus 不写 value）锁住这条线。
- **只做**：发现关卡（hook 旁听 image，比 DOM 早一拍）→ 自动 focus 输入框 → 贴身徽标贴在验证码框上方
  （剩余为主、耗时为辅，6s/12s 分档变色）→ 通关记耗时（面板「上次验证码」行）。
  **答案 p1 必须经 `stripCaptchaAnswer` 抹掉**才能进日志。
- **可选开关** `captchaAutoStart`（默认关）：验证码期自动开扫。⚠️ `popup/popup.js` 有自己一份
  `normalizePrefs` 会丢未知字段——**新增 prefs 字段必须 content 与 popup 两边同步**，
  否则 popup 点任意 chip 就会把它重置。
- DOM 契约：`ModalCaptchaText_captchaBox/_captchaImage/_captchaInput/_captchaError`（文字）、
  `ModalCaptchaSlider_captchaPlugin`（滑块）。class 带构建哈希，必须包含匹配。

## UI 组件的三个教训（v0.6）

- **全屏浮层必须把宿主 div 本身做成定位层**（`:host{all:initial}` + `position:fixed` + `width/height:100vw/vh`）。
  v0.5.1 的「放大图」点了没反应的根因：`<style>` 定义了 `.modal{position:fixed;inset:0}` 但
  **markup 里没有任何元素带这个类** → 浮层从未存在，内容掉到 `<body>` 末尾（视口外）。
  已用无头 Chrome 复现（`test/harness/fullmap.html?mode=old`）。
- **面板按钮用事件委托**（`[data-act]`），不要逐个 `el.onclick`：中途一个 `getElementById` 返回 null
  抛错，后面的按钮全部变死键。
- **面板默认贴左**（v0.6.1，用户明确要求：贴右会挡住选座区域）。位置记忆存
  `chrome.storage.local.panelPos`，拖动 mouseup 落盘、启动读回、resize 重夹。
  定位解算在 `lib/panel-pos.js`（纯函数）：横向整块可见、纵向只保证标题栏 ≥120px 可抓
  （允许下沿出屏，与桌面窗口行为一致）；镜像用**中心点**判边。头部 `⇔` 一键贴左/贴右。

## 技术约定

- **任务模型 =「页面即任务」**（v0.5 起）：不再有"新建监控任务"步骤。座位页自己用
  `lib/seat-prefs.js` 的 `buildAdHocTask(page, prefs)` 构造任务，id = `scout:{goods}:{place}:{playSeq}`。
  `adHoc: true` 表示"依存于当前活页面"→ 浏览器重启后**不自动拉起**、页面刷新后仅
  **同一场演出**才续扫、找不到座位页时**不去替用户开页面**。
- **捡漏参数唯一来源**：`chrome.storage.local.scoutPrefs`。页面浮动面板与 popup 共用，
  靠 `storage.onChanged` 双向同步。默认全部价位/全部区域/1 张/不挑位置；
  轮询间隔夹 1200~10000ms。
- **注意 `publicTask()` 没有 `mode` 字段**：往 `storage.autoStartTask` 存续扫令牌必须走
  `resumeToken()`，否则内容脚本的 `prev.mode !== 'seat'` 判断永远为真、续扫静默失效。
- 插件是 MV3，`background.service_worker` 用 ES module；**内容脚本不能用 import**，
  凡是内容脚本要用到的 lib 代码，必须经 `node tools/build.mjs` 打包进 `content/seat-bundle.js`，
  manifest 里加载的是 bundle 而不是源文件。改完 lib 或 `content/onestop-seat.js` 记得重新打包。
- 商品页解析走 RSC payload（`self.__next_f.push` 里的 `"ticketDetail"`），不要试图读可见 DOM。
- 座位页取数只能在 `tickets.interpark.com` 页面上下文（内容脚本）里做；
  会话靠请求头 `x-onestop-session`，由 `content/onestop-hook.js`（MAIN world，只读）旁听获得。
- **`seatStatus` 解码铁律**（改这块代码前必读）：座位位下标 = `seatMeta` 返回**数组的下标**
  （seatInfoId 升序，不是 rowIdx/colIdx 栅格序）；字符 = `pos >> 2`；取第 `3 - (pos & 3)` 位（MSB 优先）；
  `1` = 可购，`0` = 不可购。所以 `buildCatalog` **必须保持 seatMeta 原序**。
- **档位用「档位号」做键**，不要用名字：`seatMeta` 返回韩文名（스탠딩/지정석），
  `seats/grades` 与 `GetSeatGradePrices` 在英文界面下返回英文名（STANDING/Assigned Seat）。
  ⚠️ 踩坑记录（v0.5.1 修）：`block.gradeCounts` 的键是**档位名**，而选区里点出来的是
  **档位号**。任何"区块 × 档位"的配对都必须走 `block.gradeNos`（或 `blockGradeKeys()`），
  曾经在 `targetBlocks` 和地图着色上各错一次 → 表现为**一勾价位，目标区块就归零**。
- **选区只有一处定义**：`lib/seat-prefs.js` 的 `resolveScope(prefs, catalog, {exposableOnly})`
  同时供「地图高亮 + 选区回显 + popup 显示」和「`targetBlocks` 真正扫哪些块」使用。
  展示口径排除 `isExposable:false` 的结算虚拟区块，扫描口径要带上它们（`exposableOnly:false`）。
  改筛选规则只改这里，别在 UI 里另写一份（popup 因为是普通脚本无法 import，保留了一份等价实现
  `computeScope`，两处必须同步改）。
- **连座判定必须按真实几何**（同 `rowIdx` 且 `x` 间距 ≤ 该行座距 × 1.35），
  按数组下标相邻会在站票区（입장번호）误判。
- **坐标换算**：`posLeft = block.absoluteLeft + colIdx × 3.0`；座位画布 = 场馆 SVG 的 viewBox 空间。
- **定位标定只能用 `isExposable:true` 的座位**：`seatMeta` 里混着非可见的"结算用"座位
  （如 26000166 的 `001:014` 在 x 353~380，远在底图 316×305 之外），混进来会把包围盒拉偏。
- **页面 DOM 契约**（class 带构建哈希，必须前缀匹配）：座位层 `[class*="SeatMap_seatGroup"]>svg`
  （viewBox 即座位坐标空间）、底图 `[class*="SeatMap_placeImg"]>img`、缩略图 `[class*="MiniMap"]`
  （**必须显式排除**，旧版按宽高比挑画布会误选它）。坐标换算一律用 `getScreenCTM()`，不要用 rect 分轴比例。
- 任何接口改动都要跑 `node test/verify-har.mjs`（用真实抓包做回归，当前 228 项断言全绿）。
  ⚠️ 里面有断言**打包产物内容**的用例，先跑 `node tools/build.mjs` 再跑测试。
- 视觉回归（可选）：无头 Chrome 跑 `test/harness/fullmap.html`（从真实 HAR 提取的夹具，
  桩掉 chrome.*/fetch，验证建目录→全屏座位图全链路）。⚠️ `file://` 页 `location.origin` 是
  字符串 `"null"`，postMessage 用它当 targetOrigin 会被丢，harness 里要用 `'*'`。
- **筛选 UI 的实时性**：面板里点区域/价位 chip 只调 `syncScopeUI()`（局部重绘 chip 状态 +
  选区回显 + `#mapBox` 地图），不要调 `renderPanel()` 整块重建 —— 地图可能上万个 SVG 节点。
  `storage.onChanged` 里也要先用 `JSON.stringify` 比对，跳过自己刚写进去的那次，否则一次点击重绘两遍。

## 输出约定

- 涉及金额时**同时给韩元与人民币**。汇率口径：2026-10-06 为 1 KRW ≈ 0.00496 CNY
  （插件 UI 里硬编码的换算系数就在 `popup/popup.js` 的 `krw2cny`，需要时同步更新）。
- 用户是中文用户，交付物以中文为主。
