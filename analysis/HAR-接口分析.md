# NOL World / Interpark onestop 购票链路 — 抓包接口分析

> 数据来源：用户真实抓包 `tickets.interpark.com.har`（两份，见下表）。
> 本文只做**技术分析**，用于实现"回流票监控 + 精确定位"；不含任何自动下单实现。

## 0. 两份抓包的分工

| | 抓包 A | 抓包 B |
|---|---|---|
| 商品 | `26012479` | `26010474` |
| 场馆 | `26001057` | `26000166`（블루스퀘어 우리WON뱅킹홀）|
| 场次 | 2026-10-09~11（JX CORE in INCHEON）| 2026-10-17~18（ano LIVE in SEOUL）|
| 状态 | **全场售罄** | **有余票**（抓包时 STANDING 852 / Assigned 43）|
| 价值 | 确立 "`0` = 无可售" | 确立**位级语义**、坐标系、锁定链路 |

只有第二份（有票）才能把状态串解析到**单个座位**——售罄场次全是 `0`，只能证明"没有票"。

---

## 1. 完整流程（抓包 B 实测时序）

```
 +0.00s  GET  /api/ticket/v2/reserve-gate/goods-info      goodsCode/placeCode/开售时间/结束时间
 +0.00s  GET  /v1/getServerTime                          服务器时间（毫秒）
 +0.00s  GET  /api/ticket/v2/reserve-gate/member-info     memberCode / signature / secureData
 +3.56s  POST ent-waiting-api/waiting/api/secure-url
+15.50s  POST ent-waiting-api/waiting/api/line-up         → waitingId
+16.20s  GET  ent-waiting-api/waiting/api/rank            → 轮询排队名次
+18.49s  GET  .../rank                                    → 放行：sessionId + oneStopUrl
+32.05s  GET  /onestop/api/play/play-date/26010474        可售日期
+34.17s  POST /onestop/gql  GetPlaySeqsForDate            每场 + 每档位 remainCount
+37.65s  GET  /onestop/_next/data/.../seat.json           进入选座页
+37.86s  GET  /onestop/api/seats/grades                   class 颜色 + remainCount
+43.83s  GET  /onestop/api/seats/block-data               46/8 个区块的绝对坐标
+43.94s  POST /onestop/api/captcha/image                  图形验证码（Img + EncRnd）
+47.54s  GET  /onestop/api/seatMeta                       座位明细（2 区块/次）
+47.55s  GET  /onestop/api/seatStatus                     逐座位可购位图（8~16 区块/次）
+52.28s  GET  /onestop/api/captcha/verify?p1..p9          验证码校验 → {"result":"Y"}
+56.21s  POST /onestop/gql  PreselectSeat                 预选座位（点击座位）
+58.47s  GET  seatStatus                                  轮询中
+61.41s  POST /onestop/gql  ExpiredSession
+61.61s  POST /onestop/api/seats/select                   ★ 锁定座位
+61.90s  GET  seatStatus
+62.21s  GET  /onestop/_next/data/.../seat.json?step=price
+62.66s  GET  /onestop/api/prices/...                     该档位价格与余票
+72.90s  POST /onestop/gql  ValidatePricingSelection       校验票价选择
+74.53s  GET  /onestop/_next/data/.../payment.json         进入付款页
+75.14s  GET  /onestop/api/paymentInitEssential            配送/协议/手续费
+75.14s  GET  /onestop/api/payment/init-additional/...     优惠券/银行
+75.14s  POST /onestop/gql  ExpiredSession
```

**鉴权**：不用 Cookie。会话走请求头 `x-onestop-session`（值 = 排队放行时 `rank` 返回的 `sessionId`），
另加 `x-onestop-channel: TRIPLE_KOREA`、`x-ticket-bff-language: EN`、`x-onestop-trace-id`。
→ 所以任何接口调用都必须在 `tickets.interpark.com` 页面上下文里带着这些头发出。

---

## 2. 三层余票接口

| 层级 | 接口 | 频率 | 拿到什么 |
|---|---|---|---|
| 场次 | `POST /onestop/gql` `GetPlaySeqsForDate` | 一次 | `isSeatRemain` + **每档位精确 remainCount** |
| 档位 | `GET /onestop/api/seats/grades` | 一次 | 档位颜色 `salesColor`、价格、`remainCount` |
| 区块 | `GET /onestop/api/seats/block-data` | 一次 | 区块矩形（absoluteLeft/Top/Right/Bottom）|
| 座位 | `GET /onestop/api/seatMeta` | **一次性**，2 区块/次 | 每座 `seatInfoId / seatGrade / rowNo / seatNo / posLeft / posTop / rowIdx / colIdx / isExposable` |
| **状态** | `GET /onestop/api/seatStatus` | **轮询**，8~16 区块/次 | **逐座位可购位图** |

### 2.1 seatStatus 请求

```
GET /onestop/api/seatStatus
  ?goodsCode=26010474&placeCode=26000166&playSeq=001
  &blockKeys=001%3A001&blockKeys=001%3A002&...&bizCode=10965
→ {"data":["0000…001F","0000…","…"]}     data[i] ↔ blockKeys[i]
```

* 字符串长度 **恒等于 `ceil(该区块座位数 / 4)`**（抓包 B：8/8 区块吻合）
* 每个字符 = 1 个十六进制数 = 4 个二进制位 = **4 个连续座位**

### 2.2 解码规则（已双向验证）

```
座位位下标 pos = 该座位在 seatMeta 数组中的下标（seatInfoId 升序，不是栅格坐标序）
字符下标        = pos >> 2
取第几位        = 3 - (pos & 3)      ← MSB 优先
值 1 = 可购；0 = 已售 / 被占 / 不可售
```

**证据链（四条，互相独立）**

1. **长度律**：8/8 区块满足 `len(status) = ceil(seatMeta 座位数 / 4)`。排除"只编码可见座位"（001:001 可见 890，`ceil(890/4)=223 ≠ 250`）。
2. **锁定翻转**（最强）：轮询 `07:29:52.438` 时区块 `001:001` 的**第 48 个字符由 `8` 变成 `0`**，紧接着 `07:29:55.865` 就发出了 `seats/select`；被锁定的 `seatInfoId = 26010474:26000166:001:194` 在 seatMeta 数组中**下标恰为 192** → 字符 `192>>2 = 48`、位 `3-(192&3) = 3`。`8 = 0b1000` → 第 3 位为 1（可购）；变 `0` 后为 0（已占）。
   * 四种假设（数组序/栅格序 × MSB/LSB）里**只有"数组序 + MSB"这一组自洽**。
   * 该次变化在整个区块里**只涉及 1 个字符**，正好对应"只锁了 1 张票"。
3. **售罄反证**：抓包 A 全场售罄，34821 个字符**全部为 `0`**。
4. **数量交叉验证**：抓包 B 中按档位求和的可购位数 ≈ `grades` 接口的 `remainCount`（Assigned Seat 43 = 43；STANDING 849 vs 852，差 3 是快照时间差）。

> 结论：`seatStatus` 足以确定**具体哪些座位有票**，不再需要"某个 4 座组里有票"这种模糊判断。

### 2.3 区块 / 区域 / 档位 对照（抓包 B）

| blockKey | 区域 | 座位数 | 可见 | 档位构成 | 矩形 (x,y,w,h) |
|---|---|---|---|---|---|
| 001:001 | A구역 | 1000 | 890 | 스탠딩 890 | 80.2, 58.4, 72, 117 |
| 001:002 | B구역 | 1000 | 890 | 스탠딩 890 | 166.6, 58.3, 72, 117 |
| 001:003 | C구역 | 200 | 200 | 스탠딩 200 | 82.7, 187.4, 57, 27 |
| 001:004 | D구역 | 200 | 200 | 스탠딩 200 | 178.9, 187.1, 57, 27 |
| 001:011 | 객석2층 | 369 | 294 | 지정석 294 | 86.4, 257.1, 141, 24 |
| 001:012 | 1F 柱区 | 6 | 0 | — | 81.5, 233.3, 0, 15 |
| 001:013 | 2F 柱区 | 6 | 0 | — | … |
| 001:014 | 결제용 | 100 | 0 | — | 353.1, 169.1, …（虚拟区块，无座位）|

* 档位号是唯一稳定的键：`seatMeta` 返回韩文名（스탠딩 / 지정석），`seats/grades` 在英文界面下返回英文名（STANDING / Assigned Seat）。**用名字匹配会全部对不上。**
* 区域名：`seatMeta.rowNo` 形如 `A구역 입장번호`（站立区，含 구역 名）或 `10열`（指定席，只有排号）→ 后者退回用 `floor`（객석2층）作区域。

---

## 3. 坐标系与页面锚定（"精确定位"的关键）

### 3.1 接口坐标 = 座位层坐标系

`seatMeta.posLeft/posTop` 与 `block-data.absolute*` **属于同一张画布**，且实测：

```
posLeft = block.absoluteLeft + colIdx × 3.0
posTop  = block.absoluteTop  + rowIdx × 3.0
```

抓包 B 的坐标范围：**可见座位** `x ∈ [80.2, 238.6]`、`y ∈ [58.3, 281.1]`；
场馆座位图 SVG `viewBox="0 0 316 305"` —— 可见座位整块正好落在里面。

⚠️ **一个必须避开的坑**：同一个 `seatMeta` 里还混着**非可见的"结算用"座位**
（`isExposable:false`、`seatGrade:null`），例如区块 `001:014` 那 100 个坐标在
`x ∈ [353.1, 380.1]` —— **远在底图之外**。算包围盒、做标定时必须只用 `isExposable:true` 的座位，
否则整张图的比例会全错（这正是早期版本定位跑偏的原因之一）。

### 3.2 页面 DOM 契约（选座页实测）

class 名带构建哈希（`SeatMap_seatGroup__dH6wd`），所以一律**前缀匹配**：

| 层 | 选择器 | 作用 | 实测 |
|---|---|---|---|
| **座位层** | `[class*="SeatMap_seatGroup"]` → `<svg>` | 页面在这里**逐座位**画图，`viewBox` 即座位坐标空间 | `viewBox="0 0 527 700"`，渲染 1883×2508 |
| 底图 | `[class*="SeatMap_placeImg"]` → `<img>` | 场馆轮廓 SVG | natural 527×700（**与座位层 viewBox 相等**）|
| 缩略图 | `[class*="MiniMap"]` → `<img>` | 右下角导航小图 | natural 527×700，渲染仅 108×143 |

座位层 `viewBox` == 底图自然尺寸 → 页面就是**拿接口坐标直接画进座位层**的，
所以能做到元素级（像素级）锚定。

### 3.3 三道定位（插件实现）

1. **锚定**：座位层 svg 的 `getScreenCTM()` 给出 user space ↔ 屏幕坐标的精确变换，
   自动涵盖页面缩放/平移/父级 transform（旧版按 `渲染宽/viewBox宽` 分轴比例算，遇 transform 就偏）。
2. **标定**：把页面**已渲染的座位元素**屏幕坐标反算回 user space，与接口坐标拟合，
   解 `sx/sy/dx/dy`（自动尝试 x↔y 互换）；用 **残差 ÷ 座距** 给出 `精确 / 粗略 / 不可用`。
   页面只渲染当前放大区块时，逐区块比对挑出对得上的那一个；结果按 `placeCode` 缓存。
3. **落点**：能对上座位元素 → 直接给那个元素加高亮类；对不上 → 脉冲圆环兜底。滚动/缩放后按 user space 重算。

实现：`extension/lib/locator.js`（纯函数）+ `content/onestop-seat.js`（DOM 胶水）。
回归：`node test/verify-har.mjs` 第 8 节（等比 / 非等比 / x↔y 互换 / 只渲染单区块 /
虚拟座位污染 / 随机点不被误判 / 1:1 推定分支）。

---

## 4. 座位锁定链路（仅记录，插件不实现）

点击座位 → 进入付款，依次发生：

| 步骤 | 请求 | 载荷 |
|---|---|---|
| 预选 | `POST /onestop/gql` `PreselectSeat` | `{playSeq, blockKey, seatGrade, seatInfoId}` → `true` |
| **锁定** | `POST /onestop/api/seats/select` | 见下 |
| 计价 | `GET /onestop/api/prices/{goodsCode}` | `?placeCode&playSeq&bizCode&entMemberCode&seatType=DEFAULT&seatGrade=1` |
| 校验 | `POST /onestop/gql` `ValidatePricingSelection` | `{playSeq, selectedPrices:[{seatGrade, priceGrade, selectCnt}]}` |
| 付款 | `GET /onestop/_next/data/.../payment.json` → `paymentInitEssential` → `payment/init-additional` | — |

`seats/select` 请求体（原文）：

```json
{"goodsCode":"26010474","placeCode":"26000166","playSeq":"001","seatType":"DEFAULT",
 "seats":[{"seatGrade":"1","seatInfoId":"26010474:26000166:001:194"}],
 "sessionId":"26010474_M0000001661831791271752","autoAssign":false}
```

响应：`{"unselectableSeatInfoIds":[]}`（空数组 = 全部锁定成功）。

其他相关 mutation：
* `InitSeat{playSeq}` → `{ticketMaxCount:3, isInterlocking:false}`（每账号最多 3 张）
* `BulkDeselectSeats{seatInfoIds:[]}` → 取消选择
* `ExpiredSession` → 会话是否过期
* `GET /onestop/api/captcha/image` → `{Img: data:image/jpeg;base64,…, EncRnd:"…"}`；`GET /onestop/api/captcha/verify?p1=答案&p2=sessionId&p3=goodsCode&p4=entMemberCode&p5=bizCode&p9=EncRnd` → `{"result":"Y"}`

> **插件不实现这一段**：韩国《공연법》第 14 条禁止用自动程序（매크로）购买演出票，NOL 商品页也明文写明检测到 macro 会取消订单并封号。插件只做监控 + 定位，最后一步点击由人完成。

---

## 5. 官网自身的节奏（用于设定插件的轮询间隔）

* `seatStatus` 轮询间隔中位数 **≈ 3.8 秒**（抓包 B：3.23 / 3.92 / 3.77 / 3.43；抓包 A：中位 4.55，最快 2.61）
* 插件默认 **2800ms**，有意略快于官网但保持在同量级，并带 ±15% 抖动与错误指数退避。
* `seatMeta` 官网按 **2 个区块/次**并发 4 条；`seatStatus` **8（抓包 B）/16（抓包 A）个区块/次**。

---

## 6. 商品元信息（抓包 B）

```json
{"goodsCode":"26010474","goodsName":"ano LIVE in SEOUL, KOREA 2026",
 "placeName":"블루스퀘어 우리WON뱅킹홀","playStartDate":"20261017","playEndDate":"20261018",
 "ticketOpenDate":"202607212000","bookingEndDate":"202610171100",
 "genreCodeName":"콘서트","genreSubCodeName":"내한공연","reserveBizCode":"10965"}
```

* 全场统一价 **₩138,000**（仅档位不同：스탠딩 = 站立入场号，지정석 = 对号入座）
* 每账号限购 3 张；场次 `001` = 2026-10-17 18:00

---

## 7. 仍未确定 / 需要补充

1. **页面座位元素的身份信息**：DOM 契约（3.2）已实测确认，`getScreenCTM` 与"用页面座位反解标定"
   也已实现并通过回归。仍缺一条：页面画出来的每个座位元素**是否带可识别属性**（如 `data-seat-id`）。
   若有，就能把"接口座位 ↔ 页面元素"做成确定性 1:1 映射（而不是靠最近邻几何配对）；
   可通过插件里的 `PROBE_SEAT_CANVAS` 诊断或 `extension/README.md` 3.5 的控制台脚本确认。
2. **非零字符是否还有别的含义**：目前只在"1=可购 / 0=不可购"这一层被证实（四条证据一致）。
   若出现"字符非零但座位其实不可售"的情况，需要一份"部分售出 + 完整下单"的抓包再核对。
3. **`autoAssign: true` 的行为**：抓包只有 `false`。若要用官网自带的"自动配座"，需要另抓一次。
