# 小汐网页端 Live2D 修复规格（2026-11-03）

## 1. 目标与范围

在一次改动中解决用户提出的 5 个问题，且不删除任何既有功能：

1. 待机动作不会互相切换
2. 点击模型部位后语音与动作重复
3. 缺少「换衣服」功能（参考项目有）
4. 模型在页面中的位置需要再往上一点
5. TTS 音色（音调）会随情绪变化，听感不统一

涉及文件（仅改这些）：

- `frontend/src/components/Live2DStage.jsx`
- `frontend/src/App.jsx`
- `frontend/src/components/ChatDock.jsx`
- `frontend/src/components/DebugPanel.jsx`
- `frontend/src/lib/emotions.js`
- `frontend/src/styles.css`（仅在需要时）
- `frontend/public/live2d/DeepSeek/大肥鱼.model3.json`
- `backend/main.py`

不改动：4 套情绪表情文件、SSE 流式对话、分句流式 TTS、语音输入手动开关、调试台日志、折叠聊天栏、视线跟随、拖拽回弹。

## 2. 已确认的根因（基于实际文件核对）

### 2.1 待机动作不切换

- `大肥鱼.model3.json` 当前只有 `Idle` 组（仅 `IDLE.motion3.json`），引擎的自动待机只会从 `Idle` 组随机播放，因此永远只有同一段。
- 8 个 motion3.json 的 `Meta.Loop` 全部为 `true`，`IDLE` 因此永不结束，引擎的 `motionFinish → startRandomMotion(Idle)` 链不会触发。
- 引擎在动作结束后会自动用 **priority = 1 (IDLE)** 恢复 `Idle` 组；因此插入的额外待机动作必须用 **priority = 2 (NORMAL)** 才能覆盖，并用 `loop:false` 结束。
- 已核对的可用动作文件：`IDLE`、`举手切默认手`、`默认手切举手`、`竖手指切出来动画`、`竖手指切回默认`、`狗尾草切换出来`、`狗尾草切回默认手`、`脱捕`。

### 2.2 点击后语音和动作重复

- 动作重复：`Tap` 组的 3 个 motion 也是 `Loop: true`，`model.motion('Tap')` 未传 `loop:false`，点一次会无限循环。
- 语音重复：`App.handlePoke` 每次点击都 `sentenceQueue.current.push(text)`，上一次未播完时继续入队，连点会叠加同一句；且缺少同一部位的去重时间窗。

### 2.3 换装未实现

- 换装素材已在 `frontend/public/live2d/DeepSeek/Exp3/`，参数与取值已核对：
  - `裙子切换.exp3.json` → `Clothes1 = -1`
  - `胸口衣服.exp3.json` → `Clothes3 = 1`
  - `体型1.exp3.json` → `Clothes2 = 0.4`
  - `默认体型.exp3.json` → `Clothes2 = 0`
- 不能直接用 `model.expression()`：表情管理器是互斥的，换装会顶掉 `emotion_*` 情绪表情。
- 正确做法：在 `internalModel` 的 `beforeMotionUpdate` / `beforeModelUpdate` 每帧写入参数。`beforeMotionUpdate` 在 physics 之前，`Clothes1/Clothes2` 作为 physics 输入才能生效；`beforeModelUpdate` 保证绘制前值一定存在。
- 注意：`coreModel.setParameterValueById()` 需要 `CubismId` 句柄，必须用 `internalModel.idManager.getId('Clothes1')`，直接传字符串不会命中参数。

### 2.4 模型位置

- `fitModel()` 当前 `model.y = screenH * 0.54`，上移即减小系数。

### 2.5 音色变化

- `backend/main.py` 的 `_EMOTION_PROSODY` 为不同情绪设置不同 `pitch`（happy `+25Hz`、shy `+18Hz`、sleepy `-12Hz`），同一 `zh-CN-XiaoyiNeural` 声线被改调，听感就像换了音色。

## 3. 实施方案（决策完成）

### 3.1 `大肥鱼.model3.json`

在 `FileReferences.Motions` 下保留 `Idle`（仅 `IDLE`）与 `Tap`（3 个原有动作），新增：

```json
"IdleExtra": [
  { "File": "Animation/默认手切举手.motion3.json" },
  { "File": "Animation/举手切默认手.motion3.json" },
  { "File": "Animation/竖手指切出来动画.motion3.json" },
  { "File": "Animation/竖手指切回默认.motion3.json" },
  { "File": "Animation/狗尾草切换出来.motion3.json" },
  { "File": "Animation/狗尾草切回默认手.motion3.json" },
  { "File": "Animation/脱捕.motion3.json" }
]
```

索引约定（代码里按索引播放）：

| index | 动作 | 作用 |
| --- | --- | --- |
| 0 | 默认手切举手 | 抬手 |
| 1 | 举手切默认手 | 放下 |
| 2 | 竖手指切出来动画 | 竖手指 |
| 3 | 竖手指切回默认 | 收回 |
| 4 | 狗尾草切换出来 | 拿出狗尾草 |
| 5 | 狗尾草切回默认手 | 收回 |
| 6 | 脱捕 | 长待机小动作 |

### 3.2 `Live2DStage.jsx`

1. **上移**：`model.y = screenH * 0.50`（原 0.54）。
2. **待机轮换**：
   - 定义成对序列（每对都以默认手结束，避免手势卡住）：
     - `[0, 1]` 抬手 → 放下
     - `[2, 3]` 竖手指 → 收回
     - `[4, 5]` 狗尾草 → 收回
     - `[6]` 脱捕（单段长动作）
   - 把原来的 `scheduleIdleMotion` 重写为：每 12–20 秒随机挑一对；触发条件 `emotionRef.current === 'idle'`、`!dragging`、`motionManager.playing === false`。
   - 每段用 `model.motion('IdleExtra', index, 2, { loop: false, onFinish })`；`onFinish` 里播下一段，整组结束后由引擎自动回到 `Idle`（priority 1）。
   - 保留原有 `window.__stageState` 调试接口，新增 `idleSequence` 当前序列名。
3. **点击动作不循环**：
   - `handleUp` 与所有 `model.motion('Tap')` 调用改为 `model.motion('Tap', undefined, 2, { loop: false })`。
   - 增加同部位去重：`lastPokeRef = { zone, at }`，同一 zone 在 1500ms 内忽略（不触发动作、不上报 onPoke）。
4. **换装**：
   - 新增 prop `outfit`（对象，含 `clothes1/clothes3/clothes2`）。
   - `outfitRef` 实时保存最新值。
   - 模型加载后，在 `internalModel` 上注册 `beforeMotionUpdate` 与 `beforeModelUpdate` 回调：
     ```js
     const core = internal.coreModel
     const idm = internal.idManager
     core.setParameterValueById(idm.getId('Clothes1'), outfit.clothes1)
     core.setParameterValueById(idm.getId('Clothes3'), outfit.clothes3)
     core.setParameterValueById(idm.getId('Clothes2'), outfit.clothes2)
     ```
   - 只写这 3 个参数，不影响情绪表情（表情仍走 `model.expression()`）。
   - 销毁时移除监听，避免热更新后重复叠加。

### 3.3 `frontend/src/lib/emotions.js`

新增：

```js
export const OUTFITS = [
  { key: 'default', label: '默认装扮', short: '默认', clothes1: 0, clothes3: 0, clothes2: 0 },
  { key: 'dress', label: '小裙子', short: '裙子', clothes1: -1, clothes3: 0, clothes2: 0 },
  { key: 'dress-chest', label: '裙子 + 胸衣', short: '裙+衣', clothes1: -1, clothes3: 1, clothes2: 0 },
  { key: 'body1', label: '体型 1', short: '体型', clothes1: 0, clothes3: 0, clothes2: 0.4 },
]
```

### 3.4 `App.jsx`

1. 新增 `outfitIndex` / `outfit` 状态，默认 `OUTFITS[0]`。
2. 新增 `cycleOutfit`：循环切换，`addLog('调试', '切换装扮 → …')`，并让角色说一句（`sentenceQueue.current = [文案]` + `playNext()`）。
3. 新增 `selectOutfit(index)` 供调试台直接选择。
4. `<Live2DStage outfit={outfit} … />`。
5. `<ChatDock outfit={outfit} onCycleOutfit={cycleOutfit} … />`。
6. `handlePoke` 改为替换而不是追加：`sentenceQueue.current = [reaction.text]`，防止连续点击叠加同一句。
7. 快捷动作 / 强制开心的 `model.motion('Tap')` 统一传 `{ loop: false }`。

### 3.5 `ChatDock.jsx`

在快捷按钮行新增一枚 `换装` 按钮（`className="btn-quick btn-outfit"`）：

- 点击调用 `onCycleOutfit`
- `title` 显示「当前：{{outfit.label}}，点击切换下一套」
- 按钮文本固定「换装」，避免按钮过宽
- 不改变现有 3 个快捷按钮、语音开关、麦克风、折叠逻辑

### 3.6 `DebugPanel.jsx`

在「手动调试」区新增一小节：

- 标题「角色装扮」
- `OUTFITS` 渲染为 chip 网格，点击 `onSelectOutfit(index)`
- 当前装扮 chip 高亮（复用 `.chip-active`）

新增 props：`outfitIndex`、`onSelectOutfit`；`App.jsx` 对应传入。

### 3.7 `backend/main.py`

- 删除 `_EMOTION_PROSODY`，改为固定声线：

```python
# 统一音色：情绪只影响表情与文案，不改音调/语速
_TTS_RATE = "+0%"
_TTS_PITCH = "+0Hz"
```

- `tts()` 中改为 `edge_tts.Communicate(text, TTS_VOICE, rate=_TTS_RATE, pitch=_TTS_PITCH)`。
- `TTS_VOICE` 保持 `zh-CN-XiaoyiNeural` 不变。
- 不暴露密钥、不改 `/api/tts` 的对外协议。

## 4. 验证步骤（执行后必须逐条回报）

1. `npm run build`（`PATH` 前置 `C:\Users\link\.fnm\node-portable\node-v20.18.1-win-x64`）退出码为 0。
2. 重启后端：
   - 结束 8600 端口进程；
   - 在 `backend` 目录后台启动 `python -m uvicorn main:app --host 127.0.0.1 --port 8600`。
3. `GET http://127.0.0.1:8600/api/health` 返回 200 且 `status=ok`。
4. `POST /api/tts`（分别用 `happy` 与 `sleepy`）都返回 `audio/mpeg`；后端代码中已无按情绪变化的 `pitch`。
5. 页面轻量验证（浏览器截图或控制台）：
   - 模型整体较改动前上移；
   - 待机 12–20 秒内出现抬手/竖手指/狗尾草等成对动作，并回到默认手；
   - 点击头部/身体/脚只触发一次动作与一句语音，不再无限循环；
   - 「换装」按钮可循环切换默认/裙子/裙+衣/体型，且情绪表情不被顶掉；
   - 控制台无报错。

## 5. 风险与回滚

- `IdleExtra` 为新组，若某段动作素材缺失，引擎会记录 warning 并跳过，不影响 IDLE。
- 换装是逐帧参数覆盖，不改模型文件；若参数名与模型不匹配则视觉无变化，但不会报错。
- TTS 固定音调后不再有「情绪语调」，这是用户明确要求的统一音色。
- 回滚方式：仅回退上述 8 个文件的本次改动。

## 6. 需要用户确认

请确认以下 3 项后再执行：

1. 换装入口放在 **聊天快捷行「换装」按钮 + 调试台 chip** 是否合适；
2. 默认装扮为 `Clothes1=0 / Clothes3=0 / Clothes2=0`；
3. TTS 采用 **完全固定语调（+0Hz / +0%）**，情绪只影响表情和文案。
