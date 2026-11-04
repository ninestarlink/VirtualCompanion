import { useEffect, useRef, useState } from 'react'
import { Application, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin, configureCubismSDK } from 'untitled-pixi-live2d-engine/cubism'
import { loadPartNames, buildHitBands } from '../lib/partRegions.js'
import { PART_FEEDBACK } from '../lib/emotions.js'

const MODEL_URL = '/live2d/DeepSeek/大肥鱼.model3.json'
const CDI_URL = '/live2d/DeepSeek/大肥鱼.cdi3.json'

// 渲染内核：pixi.js 8 + untitled-pixi-live2d-engine（Cubism 5 管线）
// 旧的 pixi-live2d-display@0.4 走 Cubism 4 管线，不支持逐网格乘法色，
// 会把本模型的鼻子阴影画成实心黑块；换到 Cubism 5 内核后由引擎原生正确处理。
extensions.add(Live2DPlugin)
configureCubismSDK({ memorySizeMB: 32 })

const LOADING_TIPS = [
  '正在唤醒你的小伴侣……',
  '小汐在整理鳞片……',
  '正在注入呼吸感……',
  '马上就好，再眨一下眼……',
]

// 点击区域：按画面纵向比例划分（部件热区没算出来时的兜底）
const zoneOf = (_nx, ny) => {
  if (ny < 0.36) return 'head'
  if (ny < 0.66) return 'body'
  return 'leg'
}

// 可换装的三个部位：点击对应热区即切换
const TOGGLE_PARTS = { skirt: true, chest: true, feet: true }

// 把模型画布里的分段矩形按比例映射到角色当前的屏幕包围盒。
// 不用 toModelPosition：它的返回值带着 pixelsPerUnit 单位，和 drawable 顶点不是同一套坐标。
const bandScreenRects = (model, bands) => {
  if (!model?.internalModel || !bands?.length) return []
  const internal = model.internalModel
  const W = internal.originalWidth || 1
  const H = internal.originalHeight || 1
  const box = model.getBounds()
  const sx = (x) => box.x + (x / W) * box.width
  const sy = (y) => box.y + (y / H) * box.height
  return bands.map((b) => ({
    name: b.name,
    left: Math.min(sx(b.x0), sx(b.x1)),
    right: Math.max(sx(b.x0), sx(b.x1)),
    top: Math.min(sy(b.y0), sy(b.y1)),
    bottom: Math.max(sy(b.y0), sy(b.y1)),
  }))
}

const hitScreenRect = (rects, x, y) => {
  for (const r of rects) {
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return r.name
  }
  return null
}

// 待机成套小动作：索引对应 model3.json 里 IdleExtra 组的顺序。
// 每一组都从默认手出发、并回到默认手，避免待机后手势卡住。
const IDLE_SEQUENCES = [
  [0, 1], // 抬手 → 放下
  [2, 3], // 竖手指 → 收回
  [4, 5], // 拿出狗尾草 → 收回
  [6], // 舒展
]

export default function Live2DStage({ emotion, expression, appearance, voicePlaying, gazeFollow, gesture, emotionAction, dockOpen, onModelReady, onStatus, onPoke, onTogglePart }) {
  const wrapRef = useRef(null)
  const appRef = useRef(null)
  const modelRef = useRef(null)
  const emotionRef = useRef(emotion)
  emotionRef.current = emotion
  // 语音真正开始播放：驱动前倾、摇头点头和口型
  const voicePlayingRef = useRef(voicePlaying)
  voicePlayingRef.current = voicePlaying
  const gazeFollowRef = useRef(gazeFollow)
  gazeFollowRef.current = gazeFollow
  // 快捷按钮手势序列的播放入口，模型就绪后由 boot 填充
  const playGestureRef = useRef(null)
  // 情绪专属动作的播放入口
  const playEmotionActionRef = useRef(null)
  // 装扮参数：逐帧写入 coreModel，切换时不需要重建模型
  const appearanceRef = useRef(appearance)
  appearanceRef.current = appearance
  // 部件 Id → 中文名（cdi3），用于点击热区
  const partNamesRef = useRef(null)
  const noticeTimerRef = useRef(null)
  // 聊天栏展开时给右侧让出位置，重新排版由下面的 effect 触发
  const dockOpenRef = useRef(dockOpen)
  dockOpenRef.current = dockOpen
  const fitModelRef = useRef(null)
  // 角色在画面里的实际包围盒，用于点击分区与命中判断
  const boxRef = useRef({ top: 0, bottom: 1, left: 0, right: 1 })
  // 同一部位连点去重，避免动作/语音重复叠加
  const lastPokeRef = useRef({ zone: null, at: 0 })
  // 指针/拖拽共享状态：渲染循环与事件回调都读写这一份
  const dragRef = useRef({ centerX: 0, offset: 0, dragging: false, pressing: false, pressedAt: null })
  const [tipIndex, setTipIndex] = useState(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)
  // 换装点击后的轻量反馈（1.4 秒后自动消失，不是按钮）
  const [toggleNotice, setToggleNotice] = useState(null)

  useEffect(() => {
    let disposed = false
    let app = null
    let observer = null
    let idleTimer = null
    let greetTimer = null
    let appearanceInternal = null
    let idleSequenceActive = false
    let idleWatch = null
    // 供自动化验证观察待机成套动作的调度状态
    const idleSequence = { steps: [], index: -1, startedAt: 0 }
    const stopIdleWatch = () => {
      if (idleWatch) {
        clearInterval(idleWatch)
        idleWatch = null
      }
    }

    const fitModel = () => {
      const model = modelRef.current
      const drag = dragRef.current
      if (!model || !app) return
      const screenW = app.screen.width
      const screenH = app.screen.height

      // 右侧聊天栏占位：宽屏且展开时把角色整体左移，避免被面板压住
      const narrow = screenW < 900
      const dockOpen = !!dockOpenRef.current
      const reservedRight = dockOpen && !narrow ? Math.min(420, screenW * 0.36) : 0
      // 窄屏时聊天栏是贴底横条，改成从底部让位
      const reservedBottom = dockOpen && narrow ? Math.min(200, screenH * 0.30) : 0
      // 上下留白：之前按整屏高度铺满再上移，脚（鞋子）会跑到视口外面
      const topMargin = screenH * (narrow ? 0.07 : 0.09)
      const bottomMargin = screenH * (narrow ? 0.03 : 0.04) + reservedBottom
      const availW = Math.max(1, screenW - reservedRight)
      const availH = Math.max(1, screenH - topMargin - bottomMargin)

      const localBounds = model.getLocalBounds()
      const baseScale = Math.min(availW / Math.max(1, localBounds.width), availH / Math.max(1, localBounds.height))
      const scale = baseScale * 0.98
      model.scale.set(scale)
      model.anchor.set(0.5, 0.4)

      // 先把模型放到原点，再用实际渲染包围盒定位；这样能覆盖 Live2D 画布留白，确保鞋子不出屏
      model.x = 0
      model.y = 0
      const rendered = model.getBounds()
      // 水平居中：优先放在整屏中心；宽屏且聊天栏展开时，只向右留出刚好不压住面板的距离
      const halfWidth = rendered.width / 2
      const desiredCenterX = screenW / 2
      const dockWidth = Math.min(390, screenW - 36)
      const dockLeft = screenW - 18 - dockWidth
      const maxCenterX = dockOpen && !narrow ? dockLeft - 16 - halfWidth : screenW - 16 - halfWidth
      const targetCenterX = Math.max(halfWidth + 16, Math.min(desiredCenterX, maxCenterX))
      const targetTop = topMargin
      model.x += targetCenterX - (rendered.x + halfWidth)
      model.y += targetTop - rendered.y
      drag.centerX = model.x

      // 整体按安全区居中；窄屏聊天栏在底部时把角色中心抬高
      if (narrow && dockOpen) {
        const shiftUp = reservedBottom * 0.24
        model.y -= shiftUp
      }
      const finalBounds = model.getBounds()
      boxRef.current = {
        top: finalBounds.y,
        bottom: finalBounds.y + finalBounds.height,
        left: finalBounds.x,
        right: finalBounds.x + finalBounds.width,
      }
    }
    fitModelRef.current = fitModel

    // CubismId 必须通过 idManager 取句柄，直接传字符串不会命中参数
    const writeParam = (id, value) => {
      const model = modelRef.current
      const core = model?.internalModel?.coreModel
      const idm = model?.internalModel?.idManager
      if (!core || !idm) return
      try { core.setParameterValueById(idm.getId(id), value) } catch (_) { /* 忽略 */ }
    }

    // 装扮参数逐帧覆盖：表情（emotion_*）仍走 expression 管理器，互不冲突。
    // 取值来自模型自带的开关表情（Exp3/裙子切换、胸口衣服、脱鞋）。
    const applyAppearance = () => {
      const look = appearanceRef.current
      if (!look) return
      // 实测本模型 Clothes1 范围为 [0,1]：1 = 短裙，0 = 长裙
      writeParam('Clothes1', look.skirt === 'short' ? 1 : 0)
      writeParam('Clothes2', 0)
      writeParam('Clothes3', look.bra === 'on' ? 1 : 0)
      writeParam('Clothes4', look.shoes === 'off' ? 1 : 0)
      writeParam('Clothes5', 1)
    }

    // 语音开始播放后才轻微前倾（LeanInput 是物理输入，必须在 physics 之前写）
    const speakPose = { blend: 0, mouth: 0 }
    const applySpeakLean = () => {
      const target = voicePlayingRef.current ? 1 : 0
      // 停止时回落快一些，避免声音都结束了上身还前倾着
      speakPose.blend += (target - speakPose.blend) * (target > speakPose.blend ? 0.1 : 0.22)
      if (speakPose.blend < 0.004) speakPose.blend = 0
      writeParam('LeanInput', -8 * speakPose.blend)
    }

    // 说话时摇头 + 轻微点头 + 口型；写在 beforeModelUpdate，保证不被待机动作覆盖
    const applySpeakPose = () => {
      const amt = speakPose.blend
      if (amt <= 0) return
      const t = performance.now() / 1000
      writeParam('ParamAngleZ', Math.sin(t * 3.4) * 6 * amt)
      writeParam('ParamAngleY', Math.sin(t * 5.2) * 2.5 * amt)
      writeParam('ParamBodyAngleX', Math.sin(t * 3.4) * 1.2 * amt)

      // 口型：固定较大幅度开合，不跟音量走，保证说话时动作明显
      const target = voicePlayingRef.current
        ? 0.6 + 0.4 * Math.abs(Math.sin(t * 7.5))
        : 0
      speakPose.mouth += (target - speakPose.mouth) * (target > speakPose.mouth ? 0.5 : 0.3)
      if (voicePlayingRef.current || speakPose.mouth > 0.01) {
        writeParam('ParamMouthOpenY', speakPose.mouth)
      }
    }

    // 情绪专属动作：一段限时参数叠加（不新增素材，纯参数驱动）
    const emotionPose = { key: null, startAt: 0, duration: 1800 }
    const emotionPoseEnv = () => {
      if (!emotionPose.key) return 0
      const p = (performance.now() - emotionPose.startAt) / emotionPose.duration
      if (p >= 1) {
        emotionPose.key = null
        return 0
      }
      return Math.sin(Math.max(0, p) * Math.PI)
    }
    const applyEmotionPose = () => {
      const key = emotionPose.key
      if (!key) return
      const env = emotionPoseEnv()
      const t = performance.now() / 1000
      if (key === 'happy') {
        // 开心雀跃：小弹跳 + 头部轻晃
        writeParam('ParamAngleY', Math.sin(t * 10) * 3 * env)
        writeParam('ParamBodyAngleX', Math.sin(t * 10) * 1.5 * env)
      } else if (key === 'shy') {
        // 害羞：低头、侧头、身体微微缩起来
        writeParam('ParamAngleY', -7 * env)
        writeParam('ParamAngleZ', 6 * env)
        writeParam('ParamAngleX', 5 * env)
        writeParam('ParamBodyAngleZ', 3 * env)
      } else if (key === 'sleepy') {
        // 犯困：点头下沉 + 打哈欠
        writeParam('ParamAngleY', -5 * env)
        writeParam('ParamBodyAngleX', -2 * env)
        writeParam('ParamMouthOpenY', 0.55 * env)
      } else if (key === 'idle') {
        // 打招呼：轻轻晃头
        writeParam('ParamAngleZ', Math.sin(t * 6) * 3 * env)
      }
    }

    // 待机眨眼：本模型有循环 IDLE 动作，引擎自带的 eyeBlink 会被动作更新跳过，
    // 所以在 beforeModelUpdate 里手动按倍数收放眼睛，保留表情本身的闭眼状态。
    const blinkState = { nextAt: performance.now() + 2600, startAt: null, extra: 0 }
    let blinkCount = 0
    const applyBlink = () => {
      const model = modelRef.current
      const core = model?.internalModel?.coreModel
      const idm = model?.internalModel?.idManager
      if (!core || !idm) return
      const now = performance.now()
      if (blinkState.startAt === null && now >= blinkState.nextAt) {
        blinkState.startAt = now
        blinkCount += 1
      }
      let factor = 1
      if (blinkState.startAt !== null) {
        const p = (now - blinkState.startAt) / 160
        if (p >= 1) {
          if (blinkState.extra > 0) {
            // 连眨：上一段刚睁眼就立刻接下一段
            blinkState.extra -= 1
            blinkState.startAt = now
            blinkCount += 1
          } else {
            blinkState.startAt = null
            blinkState.nextAt = now + 2600 + Math.random() * 3400
          }
        } else if (p < 0.35) {
          factor = 1 - p / 0.35
        } else if (p < 0.6) {
          factor = 0
        } else {
          factor = (p - 0.6) / 0.4
        }
      }
      // 犯困动作里把眼睛压成半闭，做出打盹感
      if (emotionPose.key === 'sleepy') factor *= 1 - 0.85 * emotionPoseEnv()
      if (factor >= 1) return
      for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) {
        try {
          const handle = idm.getId(id)
          core.setParameterValueById(handle, core.getParameterValueById(handle) * factor)
        } catch (_) { /* 忽略 */ }
      }
    }

    // 兽耳：物理已经输出 LEar/REar 角度，这里在物理之后叠加轻微摆动和间歇抖动
    // boost 是快捷按钮回应时的抖动倍率，抖完自动回到 1
    const earState = { nextAt: performance.now() + 4200, startAt: null, boost: 1 }
    let earTwitchCount = 0
    const applyEars = () => {
      const model = modelRef.current
      const core = model?.internalModel?.coreModel
      const idm = model?.internalModel?.idManager
      if (!core || !idm) return
      const now = performance.now()
      if (earState.startAt === null && now >= earState.nextAt) {
        earState.startAt = now
        earTwitchCount += 1
      }
      let twitch = 0
      if (earState.startAt !== null) {
        const p = (now - earState.startAt) / 450
        if (p >= 1) {
          earState.startAt = null
          earState.boost = 1
          earState.nextAt = now + 4200 + Math.random() * 5000
        } else {
          twitch = Math.sin(p * Math.PI * 2) * 0.16 * (1 - p) * earState.boost
        }
      }
      const sway = Math.sin(now / 1000 * 2.1) * 0.03
      // 害羞动作期间耳朵往下趴一点
      const droop = emotionPose.key === 'shy' ? emotionPoseEnv() * 0.2 : 0
      for (const id of ['LEar1', 'LEar2', 'LEar3', 'REar1', 'REar2', 'REar3']) {
        try {
          const handle = idm.getId(id)
          const index = core.getParameterIndex(handle)
          const min = core.getParameterMinimumValue(index)
          const max = core.getParameterMaximumValue(index)
          const next = core.getParameterValueById(handle) + (min < max ? (max - min) * (sway + twitch - droop) : 0)
          core.setParameterValueById(handle, Math.max(min, Math.min(max, next)))
        } catch (_) { /* 忽略 */ }
      }
    }

    // 按顺序播放一组动作，每段 loop:false，播完自动接下一段。
    // 注意：引擎的 motion 选项 onFinish 只在动作带音频时才会回调，无音频动作永远不触发，
    // 所以这里轮询 motionManager.state 判断当前段是否已经结束（被替换或播完都算）。
    const playSequence = (model, steps, { group = 'IdleExtra', priority = 2, index = 0, debug = false } = {}) => {
      if (disposed) return
      stopIdleWatch()
      if (index >= steps.length) {
        idleSequenceActive = false
        return
      }
      const target = steps[index]
      if (debug) idleSequence.index = index
      let started
      try {
        started = model.motion(group, target, priority, { loop: false })
      } catch (_) {
        idleSequenceActive = false
        return
      }
      Promise.resolve(started)
        .then((ok) => {
          if (disposed) return
          if (!ok) {
            idleSequenceActive = false
            return
          }
          // 动作一旦下发就会成为 current，之后只要它不再是 current 就说明这段结束了
          // （播完或被点击动作顶掉都算），此时推进下一段。
          idleWatch = setInterval(() => {
            if (disposed) {
              stopIdleWatch()
              idleSequenceActive = false
              return
            }
            const st = model.internalModel?.motionManager?.state
            if (!st) {
              stopIdleWatch()
              idleSequenceActive = false
              return
            }
            if (st.currentGroup === group && st.currentIndex === target) return
            stopIdleWatch()
            playSequence(model, steps, { group, priority, index: index + 1, debug })
          }, 200)
        })
        .catch(() => { idleSequenceActive = false })
    }

    // 待机成套动作使用 IdleExtra 组，并保留调试字段
    const playIdleSequence = (model, steps) => playSequence(model, steps, { debug: true })

    // 待机随机成套动作：只在 idle、没拖拽、没有其它成套动作时触发。
    // 注意不能判断 motionManager.playing——IDLE 是循环动作，会一直是 playing。
    const scheduleIdleMotion = () => {
      clearTimeout(idleTimer)
      const delay = 12000 + Math.random() * 8000 // 12–20 秒
      idleTimer = setTimeout(() => {
        if (disposed) return
        const model = modelRef.current
        if (
          model &&
          emotionRef.current === 'idle' &&
          !dragRef.current.dragging &&
          !idleSequenceActive
        ) {
          const steps = IDLE_SEQUENCES[Math.floor(Math.random() * IDLE_SEQUENCES.length)]
          idleSequenceActive = true
          idleSequence.steps = steps
          idleSequence.startedAt = Date.now()
          playIdleSequence(model, steps)
        }
        scheduleIdleMotion()
      }, delay)
    }

    async function boot() {
      try {
        setError(null)
        const wrap = wrapRef.current
        app = new Application()
        await app.init({
          width: Math.max(1, wrap.clientWidth),
          height: Math.max(1, wrap.clientHeight),
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          preference: 'webgl',
        })
        if (disposed) {
          app.destroy(true, { children: true })
          return
        }
        appRef.current = app
        app.canvas.className = 'stage-canvas'
        app.canvas.style.display = 'block'
        app.canvas.style.width = '100%'
        app.canvas.style.height = '100%'
        app.canvas.style.touchAction = 'none'
        wrap.appendChild(app.canvas)

        const model = await Live2DModel.from(MODEL_URL, { autoHitTest: false, autoFocus: false })
        if (disposed) {
          model.destroy()
          return
        }
        modelRef.current = model
        app.stage.addChild(model)
        fitModel()

        // 装扮是长期状态，挂在每帧更新里，切换表情时不会被顶掉
        appearanceInternal = model.internalModel
        appearanceInternal?.on?.('beforeMotionUpdate', applyAppearance)
        appearanceInternal?.on?.('beforeModelUpdate', applyAppearance)
        // 说话时前倾 + 摇头点头，同样逐帧写入
        appearanceInternal?.on?.('beforeMotionUpdate', applySpeakLean)
        appearanceInternal?.on?.('beforeModelUpdate', applySpeakPose)
        // 眨眼和兽耳微动放在物理之后，避免被待机动作或物理输出覆盖
        appearanceInternal?.on?.('beforeModelUpdate', applyEmotionPose)
        appearanceInternal?.on?.('beforeModelUpdate', applyBlink)
        appearanceInternal?.on?.('beforeModelUpdate', applyEars)
        applyAppearance()

        observer = new ResizeObserver(() => {
          if (!app || disposed) return
          app.renderer.resize(Math.max(1, wrap.clientWidth), Math.max(1, wrap.clientHeight))
          fitModel()
        })
        observer.observe(wrap)

        // 松手后拖拽偏移弹性归位
        app.ticker.add(() => {
          const drag = dragRef.current
          if (!drag.dragging && drag.offset !== 0) {
            drag.offset *= 0.86
            if (Math.abs(drag.offset) < 0.5) drag.offset = 0
            model.x = drag.centerX + drag.offset
          }
        })

        // 部件名映射（cdi3）加载完，点击热区才能按真实部件算；失败时退回纵向比例
        loadPartNames(CDI_URL)
          .then((map) => {
            if (!disposed) partNamesRef.current = map
          })
          .catch((err) => console.warn('部件名加载失败，点击改用比例兜底:', err))

        setReady(true)
        window.__live2dModel = model // 供自动化验证使用
        // 把分段矩形中心换算成页面坐标，便于自动化验证精确点击
        window.__stageRegionCenters = () => {
          const internal = model.internalModel
          const names = partNamesRef.current
          if (!names) return []
          const bands = buildHitBands({ core: internal.coreModel, internalModel: internal, names })
          return bandScreenRects(model, bands).map((r) => ({
            name: r.name,
            x: Math.round((r.left + r.right) / 2),
            y: Math.round((r.top + r.bottom) / 2),
            height: Math.round(r.bottom - r.top),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
          }))
        }
        // 自动化验证用：按分段名找到当前屏幕中心，并派发真实指针事件
        window.__stageClickPart = (name) => {
          const internal = model.internalModel
          const names = partNamesRef.current
          if (!names) return null
          const bands = buildHitBands({ core: internal.coreModel, internalModel: internal, names })
          const r = bandScreenRects(model, bands).find((v) => v.name === name)
          if (!r) return null
          const x = Math.round((r.left + r.right) / 2)
          const y = Math.round((r.top + r.bottom) / 2)
          const opts = { bubbles: true, pointerId: 1, clientX: x, clientY: y, pointerType: 'mouse', button: 0 }
          app.canvas.dispatchEvent(new PointerEvent('pointerdown', opts))
          app.canvas.dispatchEvent(new PointerEvent('pointerup', opts))
          return { x, y, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] }
        }

        // 自动化排查用：给定页面坐标，返回命中的分段与各分段屏幕矩形
        window.__stageHitTest = (x, y) => {
          const internal = model.internalModel
          const names = partNamesRef.current
          if (!names) return { band: null, reason: 'cdi3-not-ready' }
          const bands = buildHitBands({ core: internal.coreModel, internalModel: internal, names })
          const rects = bandScreenRects(model, bands)
          return {
            band: hitScreenRect(rects, x, y),
            namesReady: true,
            nameCount: names.size,
            rects: rects.map((r) => `${r.name}:x${Math.round(r.left)}-${Math.round(r.right)},y${Math.round(r.top)}-${Math.round(r.bottom)}`),
          }
        }
        window.__stageState = () => ({
          x: model.x,
          y: model.y,
          scale: model.scale.x,
          blinkCount,
          earTwitchCount,
          emotionPose: { key: emotionPose.key, duration: emotionPose.duration },
          bounds: (() => { const b = model.getBounds(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } })(),
          screen: { w: app.screen.width, h: app.screen.height },
          box: boxRef.current,
          centerX: dragRef.current.centerX,
          pressing: dragRef.current.pressing,
          dragging: dragRef.current.dragging,
          offset: dragRef.current.offset,
          lastPoke: window.__lastPoke || null,
          lastClick: window.__lastClick || null,
          appearance: { ...(appearanceRef.current || {}) },
          speaking: voicePlayingRef.current,
          mouth: Math.round(speakPose.mouth * 100) / 100,
          idleSequence: {
            active: idleSequenceActive,
            steps: [...idleSequence.steps],
            index: idleSequence.index,
            startedAt: idleSequence.startedAt,
          },
        })
        onModelReady?.(model)
        onStatus?.('ready')
        // 快捷按钮手势：按顺序播放 IdleExtra 动作，成对动作能回到默认手型。
        // 同时立刻触发一次眨眼和兽耳抖动，作为被摸/被夸的即时反馈。
        playGestureRef.current = (steps) => {
          if (disposed || !steps?.length) return
          const now = performance.now()
          if (blinkState.startAt === null) {
            blinkState.startAt = now
            blinkCount += 1
          }
          if (earState.startAt === null) {
            earState.startAt = now
            earState.boost = 2.2
            earTwitchCount += 1
          }
          idleSequenceActive = true
          playSequence(model, steps, { priority: 3 })
        }
        // 情绪专属动作：参数叠加 + 复用手势素材，不新增模型资源
        playEmotionActionRef.current = (key) => {
          if (disposed || !key) return
          const now = performance.now()
          emotionPose.key = key
          emotionPose.startAt = now
          emotionPose.duration = key === 'sleepy' ? 3200 : 1800
          if (key === 'happy' || key === 'idle') {
            blinkState.startAt = now
            blinkState.extra = key === 'happy' ? 1 : 0
            blinkCount += 1
            earState.startAt = now
            earState.boost = 2.2
            earTwitchCount += 1
          }
          if (key === 'happy') {
            // 雀跃：竖手指 + 收回
            playSequence(model, [2, 3], { priority: 3 })
          } else if (key === 'shy') {
            // 害羞：抬手护住脸 + 放下
            playSequence(model, [0, 1], { priority: 3 })
          } else if (key === 'idle') {
            // 打招呼：抬手挥一下 + 放下
            playSequence(model, [0, 1], { priority: 3 })
          }
        }
        scheduleIdleMotion()
        // 初次见面打招呼
        greetTimer = setTimeout(() => {
          if (!disposed) playEmotionActionRef.current?.('idle')
        }, 1600)
      } catch (err) {
        console.error('Live2D 加载失败:', err)
        if (!disposed) {
          setError(String(err?.message || err))
          onStatus?.('error')
        }
      }
    }

    boot()

    return () => {
      disposed = true
      clearTimeout(idleTimer)
      clearTimeout(greetTimer)
      clearTimeout(noticeTimerRef.current)
      stopIdleWatch()
      observer?.disconnect()
      fitModelRef.current = null
      try {
        appearanceInternal?.off?.('beforeMotionUpdate', applyAppearance)
        appearanceInternal?.off?.('beforeModelUpdate', applyAppearance)
        appearanceInternal?.off?.('beforeMotionUpdate', applySpeakLean)
        appearanceInternal?.off?.('beforeModelUpdate', applySpeakPose)
        appearanceInternal?.off?.('beforeModelUpdate', applyEmotionPose)
        appearanceInternal?.off?.('beforeModelUpdate', applyBlink)
        appearanceInternal?.off?.('beforeModelUpdate', applyEars)
      } catch (_) { /* 忽略 */ }
      appearanceInternal = null
      playGestureRef.current = null
      playEmotionActionRef.current = null
      try {
        modelRef.current?.destroy()
      } catch (_) { /* 忽略销毁异常 */ }
      modelRef.current = null
      try {
        appRef.current?.destroy(true, { children: true })
      } catch (_) { /* 忽略销毁异常 */ }
      appRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 聊天栏展开/收起时重新排版，让角色让开/占满右侧空间
  useEffect(() => {
    fitModelRef.current?.()
  }, [dockOpen])

  // 快捷按钮手势：每次点击带新的 id，按序列播放
  useEffect(() => {
    if (!ready || !gesture?.steps?.length) return
    playGestureRef.current?.(gesture.steps)
  }, [ready, gesture])

  // 情绪专属动作：对话或调试切换情绪时触发一次
  useEffect(() => {
    if (!ready || !emotionAction?.key) return
    playEmotionActionRef.current?.(emotionAction.key)
  }, [ready, emotionAction])

  // 加载等待文案轮换
  useEffect(() => {
    const timer = setInterval(() => setTipIndex((i) => (i + 1) % LOADING_TIPS.length), 2600)
    return () => clearInterval(timer)
  }, [])

  // 情绪变化 → 切换表情（用 model3.json 里注册的表情名，不是情绪码）
  useEffect(() => {
    const model = modelRef.current
    if (!model || !expression) return
    try {
      model.expression(expression)
    } catch (err) {
      console.warn('表情切换失败:', err)
    }
  }, [expression])

  // 指针是否在聊天栏上；在聊天栏时不跟踪视线，回到舞台再恢复
  const pointerInDockRef = useRef(false)
  // 鼠标是否处于“中央固定区”，用于只触发一次回正
  const centerZoneRef = useRef(false)
  // 中央固定区最小宽度：模型实际宽度不足屏幕 30% 时按 30% 兜底
  const GAZE_CENTER_MIN_RATIO = 0.3
  // 中立视线：模型包围盒中心再向上偏 12%，让目光落在观众脸上
  const focusNeutralPoint = () => {
    const model = modelRef.current
    if (!model) return
    try {
      const bounds = model.getBounds()
      model.focus(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2 - bounds.height * 0.12,
      )
    } catch (_) { /* 忽略 */ }
  }

  // 关闭视线跟随时，视线固定到同一个中立点
  useEffect(() => {
    centerZoneRef.current = false
    if (!gazeFollow) focusNeutralPoint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gazeFollow])

  useEffect(() => {
    const onWindowMove = (e) => {
      const target = e.target
      const inDock = !!(target && target.closest && target.closest('.chat-dock'))
      if (inDock === pointerInDockRef.current) return
      pointerInDockRef.current = inDock
      if (inDock) {
        centerZoneRef.current = false
        focusNeutralPoint()
      }
    }

    // 键盘 Tab 聚焦输入框、没有鼠标移动时，也先把视线收回中立点
    const onFocusIn = (e) => {
      if (e.target?.closest?.('.chat-dock')) {
        pointerInDockRef.current = true
        centerZoneRef.current = false
        focusNeutralPoint()
      }
    }

    window.addEventListener('pointermove', onWindowMove, { passive: true })
    window.addEventListener('focusin', onFocusIn)
    return () => {
      window.removeEventListener('pointermove', onWindowMove)
      window.removeEventListener('focusin', onFocusIn)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- 指针交互 ----------
  const pointInfo = (e) => {
    const rect = wrapRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width || 1, h: rect.height || 1 }
  }

  const handleMove = (e) => {
    const model = modelRef.current
    const drag = dragRef.current
    if (!model) return
    const p = pointInfo(e)

    if (drag.pressing) {
      const dx = e.clientX - drag.pressedAt.x
      if (!drag.dragging && Math.abs(dx) > 6) drag.dragging = true
      if (drag.dragging) {
        const max = p.w * 0.28
        drag.offset = Math.max(-max, Math.min(max, dx))
        model.x = drag.centerX + drag.offset
      }
      return
    }

    // 视线跟随鼠标；关闭跟随或鼠标在聊天栏时不更新，避免打字时视线歪向一侧
    if (gazeFollowRef.current && !e.target?.closest?.('.chat-dock')) {
      const box = boxRef.current
      const nx = p.x / p.w
      // 中央固定区宽度取“模型实际宽度”和 30% 屏宽的较大值
      const modelRatio = Math.max(0, (box.right - box.left) / p.w)
      const bandRatio = Math.max(GAZE_CENTER_MIN_RATIO, modelRatio)
      const inCenter = Math.abs(nx - 0.5) <= bandRatio / 2
      if (inCenter) {
        if (!centerZoneRef.current) {
          centerZoneRef.current = true
          focusNeutralPoint()
        }
      } else {
        centerZoneRef.current = false
        try { model.focus(p.x, p.y) } catch (_) { /* 忽略 */ }
      }
    }
  }

  const handleDown = (e) => {
    const drag = dragRef.current
    drag.pressing = true
    drag.dragging = false
    drag.pressedAt = { x: e.clientX, y: e.clientY }
  }

  const handleUp = (e) => {
    const model = modelRef.current
    const drag = dragRef.current
    const wasDrag = drag.dragging
    drag.pressing = false
    drag.dragging = false
    if (!model || wasDrag) return
    const p = pointInfo(e)
    window.__lastClick = { x: Math.round(p.x), y: Math.round(p.y) }
    // 只有点在角色实际的包围盒里才算互动，避免点空白背景也触发
    const box = boxRef.current
    const padX = p.w * 0.04
    if (p.x < box.left - padX || p.x > box.right + padX) return
    if (p.y < box.top - p.h * 0.04 || p.y > box.bottom + p.h * 0.04) return

    const nowMs = performance.now()

    // 按模型自身的部件热区判断：胸 → 内衣、裙 → 裙子、脚 → 鞋子。
    // 热区来自 cdi3 部件名 + 当前帧网格，缩放/换姿势后依然对得上。
    let part = null
    window.__lastClick.part = null
    if (partNamesRef.current) {
      try {
        const internal = model.internalModel
        const bands = buildHitBands({
          core: internal.coreModel,
          internalModel: internal,
          names: partNamesRef.current,
        })
        part = hitScreenRect(bandScreenRects(model, bands), p.x, p.y)
        window.__lastClick.part = part
      } catch (_) { part = null }
    }

    if (part && TOGGLE_PARTS[part]) {
      // 0.9 秒内同一部位连点忽略，避免刚换完就手抖点回去
      if (lastPokeRef.current.zone === part && nowMs - lastPokeRef.current.at < 900) return
      lastPokeRef.current = { zone: part, at: nowMs }
      const info = PART_FEEDBACK[part]
      const current = appearanceRef.current || {}
      const next =
        part === 'skirt' ? (current.skirt === 'short' ? 'long' : 'short')
          : part === 'chest' ? (current.bra === 'on' ? 'off' : 'on')
            : (current.shoes === 'off' ? 'on' : 'off')
      // 轻量反馈：模型旁浮出一行状态，1.4 秒后消失
      setToggleNotice(`${info.label} → ${info.values[next]}`)
      clearTimeout(noticeTimerRef.current)
      noticeTimerRef.current = setTimeout(() => setToggleNotice(null), 1400)
      try { model.motion('Tap', undefined, 3, { loop: false }) } catch (_) { /* 忽略 */ }
      window.__lastPoke = part
      onTogglePart?.(part)
      return
    }

    // 其余部位保持原有互动
    const boxH = Math.max(1, box.bottom - box.top)
    const ny = Math.min(1, Math.max(0, (p.y - box.top) / boxH))
    const zone = zoneOf(p.x / p.w, ny)
    // 1.5 秒内同一部位重复点击直接忽略，避免动作和语音重复叠加
    if (lastPokeRef.current.zone === zone && nowMs - lastPokeRef.current.at < 1500) return
    lastPokeRef.current = { zone, at: nowMs }
    try { model.motion('Tap', undefined, 3, { loop: false }) } catch (_) { /* 忽略 */ }
    window.__lastPoke = zone
    onPoke?.(zone)
  }

  return (
    <div
      className="stage-wrap"
      ref={wrapRef}
      onPointerMove={handleMove}
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerLeave={() => { dragRef.current.pressing = false; dragRef.current.dragging = false }}
    >
      {!ready && !error && (
        <div className="stage-loading">
          <div className="stage-spinner" />
          <p className="stage-tip">{LOADING_TIPS[tipIndex]}</p>
          <p className="stage-subtip">首次加载约 60MB 素材，稍等片刻哦</p>
        </div>
      )}
      {error && (
        <div className="stage-error">
          <p>模型加载失败了</p>
          <p className="stage-subtip">{error}</p>
          <button className="btn-glass" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      )}
      {toggleNotice && <div className="part-toast">{toggleNotice}</div>}
    </div>
  )
}
