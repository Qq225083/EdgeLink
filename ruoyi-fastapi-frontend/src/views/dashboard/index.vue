<template>
  <div class="showcase">
    <!-- ==================== 主视觉横幅（纯渐变，无图片拉伸失真） ==================== -->
    <div class="hero">
      <div class="hero-glow glow-a" />
      <div class="hero-glow glow-b" />
      <div class="hero-overlay">
        <div class="hero-title">EdgeLink 边缘智联管理系统</div>
        <div class="hero-sub">工业采集 · 集中管控 · 配置即流程</div>
        <div class="hero-line" />
        <div class="hero-slogan">让每一台 PLC，开口说话</div>
      </div>
      <div class="hero-noise" />
      <div class="hero-scroll"><span /></div>
    </div>

    <!-- ==================== 公司简介 ==================== -->
    <div class="section reveal">
      <div class="section-inner">
        <div class="section-media">
          <img :src="img.gate" alt="公司正门" />
        </div>
        <div class="section-text">
          <div class="section-kicker">ABOUT US</div>
          <h2>公司简介</h2>
          <!-- 文案参考 murata.rczj.cn/Recruit/Profiles -->
          <p>
            无锡村田电子有限公司是日本株式会社村田制作所于 1994 年 12 月在中国无锡设立的独资企业，
            目前是村田集团最大的生产基地。公司主要生产以陶瓷材料为主的电子元器件，
            如贴片式多层陶瓷电容器（MLCC），广泛应用于智能通信、汽车电子、PC、无人驾驶、5G 设备、IoT 等领域。
          </p>
          <p>
            公司着眼于「ES（员工满意度）」与「CS（客户满意度）」，以人为本、注重人才培养，
            积极履行企业社会责任，先后荣获全国文明单位、中国质量信赖企业等多项表彰。
            目前公司员工已超过 11,000 人，第一工厂占地面积 11 万平方米，
            第二工厂于 2020 年 6 月投入生产，占地面积约 12 万平方米。
          </p>
        </div>
      </div>
    </div>

    <!-- ==================== 系统简介 ==================== -->
    <div class="section section-alt reveal">
      <div class="section-inner reverse">
        <div class="section-media">
          <img :src="img.system" alt="工业自动化" />
        </div>
        <div class="section-text">
          <div class="section-kicker">ABOUT SYSTEM</div>
          <h2>系统简介</h2>
          <p>
            EdgeLink 边缘智联系统是面向生产现场的工业数据采集与管控平台。
            系统在车间边缘侧完成 PLC 数据的采集、换算与过滤，
            通过 MQTT / PostgreSQL 双通道汇入平台，实现设备状态的集中监控与统一管理。
          </p>
          <div class="feature-row">
            <div class="feature-item">
              <i class="el-icon-cpu" />
              <div>
                <div class="feature-name">多协议接入</div>
                <div class="feature-desc">三菱 MC · Modbus · 基恩士 SLMP</div>
              </div>
            </div>
            <div class="feature-item">
              <i class="el-icon-share" />
              <div>
                <div class="feature-name">配置即流程</div>
                <div class="feature-desc">后台配置一键生成边缘采集流程</div>
              </div>
            </div>
            <div class="feature-item">
              <i class="el-icon-monitor" />
              <div>
                <div class="feature-name">集中管控</div>
                <div class="feature-desc">多现场节点统一监控与告警</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 系统架构 ==================== -->
    <div class="section reveal">
      <div class="section-head">
        <div class="section-kicker">ARCHITECTURE</div>
        <h2>系统架构</h2>
      </div>
      <div class="arch">
        <div
          v-for="l in arch"
          :key="l.name"
          class="arch-layer"
          :class="'arch-layer--' + l.tone"
        >
          <div class="arch-label">
            <span class="arch-idx">{{ l.idx }}</span>
            <div class="arch-name">{{ l.name }}</div>
            <div class="arch-en">{{ l.en }}</div>
          </div>
          <div class="arch-detail">
            <div class="arch-desc">
              {{ l.desc }}<span v-if="l.tag" class="arch-tag">{{ l.tag }}</span>
            </div>
            <div class="arch-items">
              <span v-for="it in l.items" :key="it">{{ it }}</span>
            </div>
          </div>
        </div>

        <!-- 实时通道：采集层(L2)不经数据层，直连基础应用层(L4) -->
        <div class="arch-chan">
          <div class="arch-chan-label">实时通道<br />MQTT · HTTP</div>
          <div class="arch-chan-line"><span /></div>
        </div>
      </div>
      <div class="arch-legend">
        <span class="arch-legend-item">
          <i class="arch-legend-solid" />实线：批量通道 · 经数据层汇入应用
        </span>
        <span class="arch-legend-item">
          <i class="arch-legend-dashed" />虚线：实时通道 · 采集层直连基础应用层
        </span>
      </div>
    </div>

    <!-- ==================== 企业风貌 ==================== -->
    <div class="section section-alt reveal">
      <div class="section-head">
        <div class="section-kicker">GALLERY</div>
        <h2>企业风貌</h2>
      </div>
      <div class="gallery">
        <div v-for="p in gallery" :key="p.src" class="gallery-item">
          <img :src="p.src" :alt="p.caption" />
          <div class="gallery-caption">{{ p.caption }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'DashboardIndex',
  data() {
    return {
      img: {
        gate: require('@/assets/img/company/gate.png'),
        system: require('@/assets/img/company/stock-engineer.jpg')
      },
      // 系统架构五层：L1 数据源 → L5 智慧应用，数据自上而下流经各层
      // desc = 一句"人话"（灰体小字），items = 技术对应（胶囊标签）
      arch: [
        {
          idx: 'L1', name: '数据源层', en: 'DATA SOURCE', tone: 'l1',
          desc: '数据的“出生地”：既有系统与设备实时数据的总入口',
          items: ['MySQL', 'Oracle', 'PLC', '变频器', '仪表', '传感器']
        },
        {
          idx: 'L2', name: '数据采集层', en: 'ACQUISITION', tone: 'l2',
          desc: '把分散的数据接进来、整干净，送往数据层或直接送往应用层',
          items: ['Node-RED', '三菱 MC', 'Modbus', 'MQTT', 'HTTP']
        },
        {
          idx: 'L3', name: '数据层', en: 'DATA LAYER', tone: 'l3',
          desc: '数据的“仓库”：统一存储、统一管理，随取随用',
          items: ['PostgreSQL 时序库', '帆软数仓']
        },
        {
          idx: 'L4', name: '基础应用层', en: 'APPLICATION', tone: 'l4',
          desc: '让数据“看得见”：基于数仓或实时流的基础开发',
          items: ['设备状态监视', '稼动率看板', '告警管理']
        },
        {
          idx: 'L5', name: '智慧应用层', en: 'INTELLIGENT', tone: 'l5',
          desc: '让数据“会思考”：AI 大模型驱动的进阶应用',
          tag: '规划中 · 2027→2028',
          items: ['预防性维护', '未知因子检出']
        }
      ],
      gallery: [
        { src: require('@/assets/img/company/day-1.jpg'), caption: '厂区日景' },
        { src: require('@/assets/img/company/dusk-1.jpg'), caption: '园区暮色' },
        { src: require('@/assets/img/company/night-1.jpg'), caption: '研发楼夜景' },
        { src: require('@/assets/img/company/night-2.jpg'), caption: '公司夜景' }
      ]
    }
  },
  mounted() {
    // 区块滚动渐显：进入视口才淡入
    this._observer = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('revealed')
          this._observer.unobserve(e.target)
        }
      })
    }, { threshold: 0.12 })
    this.$el.querySelectorAll('.reveal').forEach(el => this._observer.observe(el))
  },
  beforeDestroy() {
    if (this._observer) this._observer.disconnect()
  }
}
</script>

<style lang="scss" scoped>
.showcase {
  background: #f5f7fa;
  min-height: calc(100vh - 84px);
}

/* ---------- 主视觉（浅色渐变 + 柔光，轻快门户风） ---------- */
.hero {
  height: 340px;
  position: relative;
  overflow: hidden;
  isolation: isolate; /* 噪点的 mix-blend-mode 只在 hero 内部生效，不外溢到页面底色 */
  /* 底部斜切：左侧到底、右侧抬起 72px。直接裁 hero 自身，比叠一层 SVG 更省——
     不引入额外节点，也不必让分隔色跟页面底色保持同步。 */
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 72px), 0 100%);
  background:
    radial-gradient(800px 300px at 85% 15%, rgba(64, 201, 255, 0.45), transparent 60%),
    radial-gradient(600px 320px at 10% 90%, rgba(120, 180, 255, 0.35), transparent 60%),
    linear-gradient(115deg, #2f6fd8 0%, #3d8bfd 55%, #40c9ff 100%);

  .hero-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, rgba(11, 30, 63, 0.32) 0%, rgba(11, 30, 63, 0.08) 55%, transparent 100%);
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 0 8%;
  }

  .hero-title {
    font-size: 36px;
    font-weight: bold;
    color: #fff;
    letter-spacing: 2px;
    text-shadow: 0 1px 8px rgba(11, 30, 63, 0.35);
  }

  .hero-sub {
    margin-top: 14px;
    font-size: 15px;
    color: rgba(255, 255, 255, 0.9);
    letter-spacing: 2px;
  }

  .hero-line {
    width: 64px;
    height: 3px;
    background: rgba(255, 255, 255, 0.9);
    margin: 22px 0 0;
    border-radius: 2px;
  }

  /* 签名句：比副标题重一档，读作"落款"而不是第二句说明 */
  .hero-slogan {
    margin-top: 14px;
    font-size: 17px;
    font-weight: 500;
    letter-spacing: 3px;
    color: rgba(255, 255, 255, 0.95);
  }

  /* 噪点层：打散纯渐变的色阶（banding），叠加胶片颗粒质感。
     用 SVG feTurbulence 内联生成，不引入任何图片资源。 */
  .hero-noise {
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0.06;
    mix-blend-mode: overlay;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  /* 滚动提示：呼吸下移的小箭头，暗示下方还有内容 */
  .hero-scroll {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 78px; /* 文字块底部约 237px，此处起始 244px；斜切中线处约 304px */
    display: flex;
    justify-content: center;
    pointer-events: none;
    opacity: 0;
    animation: hero-in 0.9s cubic-bezier(0.22, 0.61, 0.36, 1) 0.8s forwards;

    span {
      width: 18px;
      height: 18px;
      border-right: 2px solid rgba(255, 255, 255, 0.8);
      border-bottom: 2px solid rgba(255, 255, 255, 0.8);
      animation: scroll-cue 2.2s ease-in-out infinite;
    }
  }

  /* 光晕漂移层（12s 缓慢循环，让渐变活起来） */
  .hero-glow {
    position: absolute;
    border-radius: 50%;
    filter: blur(60px);
    pointer-events: none;
  }
  .glow-a {
    width: 420px; height: 260px;
    right: 6%; top: -40px;
    background: rgba(64, 201, 255, 0.35);
    animation: glow-drift-a 12s ease-in-out infinite alternate;
  }
  .glow-b {
    width: 360px; height: 240px;
    left: 4%; bottom: -60px;
    background: rgba(120, 180, 255, 0.3);
    animation: glow-drift-b 14s ease-in-out infinite alternate;
  }

  /* 文字入场：渐显上浮，三段错峰 */
  .hero-title, .hero-sub, .hero-line, .hero-slogan {
    opacity: 0;
    animation: hero-in 0.9s cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
  }
  .hero-sub { animation-delay: 0.25s; }
  .hero-line { animation-delay: 0.45s; }
  .hero-slogan { animation-delay: 0.6s; }
}

@keyframes hero-in {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes glow-drift-a {
  from { transform: translate(0, 0) scale(1); }
  to { transform: translate(-50px, 30px) scale(1.12); }
}

@keyframes glow-drift-b {
  from { transform: translate(0, 0) scale(1); }
  to { transform: translate(60px, -24px) scale(1.08); }
}

/* 滚动提示：绕 45° 后的 translate 沿斜轴走，视觉上就是垂直下移 */
@keyframes scroll-cue {
  0%, 100% { transform: rotate(45deg) translate(0, 0); opacity: 0.45; }
  50%      { transform: rotate(45deg) translate(5px, 5px); opacity: 1; }
}

/* ---------- 区块滚动渐显 ---------- */
.reveal {
  opacity: 0;
  transform: translateY(28px);
  transition: opacity 0.7s ease, transform 0.7s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.reveal.revealed {
  opacity: 1;
  transform: translateY(0);
}

/* ---------- 图文区块 ---------- */
.section {
  /* 左右留白随视口增长，正文实际宽度上限 1200px（中文舒适行宽 30~40 字） */
  padding: 48px max(8%, calc((100% - 1200px) / 2));

  &.section-alt {
    background: #fff;
  }

  .section-inner {
    display: flex;
    align-items: center;
    gap: 48px;

    &.reverse {
      flex-direction: row-reverse;
    }
  }

  .section-media {
    flex: 0 0 44%;

    img {
      width: 100%;
      border-radius: 10px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
      display: block;
    }
  }

  .section-text {
    flex: 1;

    h2 {
      font-size: 24px;
      color: #1f2d3d;
      margin: 6px 0 16px;
    }

    p {
      font-size: 14px;
      color: #5e6d82;
      line-height: 1.9;
      margin: 0 0 12px;
    }
  }

  .section-kicker {
    font-size: 12px;
    letter-spacing: 3px;
    color: #3d8bfd;
    font-weight: bold;
  }
}

/* ---------- 特性三点 ---------- */
.feature-row {
  display: flex;
  gap: 18px;
  margin-top: 22px;

  .feature-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;

    i {
      font-size: 22px;
      color: #3d8bfd;
      margin-top: 2px;
    }

    .feature-name { font-size: 13px; font-weight: bold; color: #303133; }
    .feature-desc { font-size: 12px; color: #909399; margin-top: 3px; line-height: 1.5; }
  }
}

/* ---------- 居中区块标题（系统架构 / 企业风貌 共用） ---------- */
.section-head {
  text-align: center;
  margin-bottom: 28px;

  h2 { font-size: 24px; color: #1f2d3d; margin: 6px 0 0; }
  .section-kicker { font-size: 12px; letter-spacing: 3px; color: #3d8bfd; font-weight: bold; }
}

/* ---------- 系统架构（数据链路五层图） ---------- */
.arch {
  max-width: 900px; /* 窄于正文，读作"一张图"而不是又一段内容 */
  margin: 0 auto;
  display: grid;
  grid-template-columns: 1fr 128px; /* 右侧一列留给实时通道虚线 */
  row-gap: 10px;
}

.arch-layer {
  grid-column: 1;
  position: relative;
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 16px 22px;
  background: #fff;
  border-radius: 12px;
  border: 1px solid #eef2f8; /* 白底上压一层极淡描边，五张卡片才不会糊成一片 */
  border-left: 3px solid #c8d3e0;
  box-shadow: 0 2px 10px rgba(11, 30, 63, 0.06);
  transition: transform 0.25s ease, box-shadow 0.25s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(11, 30, 63, 0.12);
  }

  /* 层间实线箭头：数据沿 L1→L5 逐层下走，与右侧虚线实时通道构成对比 */
  & + .arch-layer::before {
    content: '';
    position: absolute;
    top: -9px;
    left: 50%;
    width: 7px;
    height: 7px;
    border-right: 2px solid #c8d6ea;
    border-bottom: 2px solid #c8d6ea;
    transform: translateX(-50%) rotate(45deg);
  }

  /* 色条由浅到深：越靠下游，数据越接近决策 */
  &--l1 { border-left-color: #b9cbe4; }
  &--l2 { border-left-color: #7fb0f5; }
  &--l3 { border-left-color: #3d8bfd; }
  &--l4 { border-left-color: #2f6fd8; }
  &--l5 { border-left-color: #1e4f9e; border-left-style: dashed; }
}

.arch-label {
  flex: 0 0 122px;

  .arch-idx {
    display: inline-block;
    font-size: 10px;
    font-weight: bold;
    letter-spacing: 1px;
    color: #3d8bfd;
    background: #eef4fe;
    border-radius: 4px;
    padding: 1px 6px;
  }

  .arch-name { font-size: 15px; font-weight: bold; color: #1f2d3d; margin-top: 5px; }
  .arch-en { font-size: 10px; letter-spacing: 1.5px; color: #a0a8b5; margin-top: 3px; }
}

.arch-detail { flex: 1; min-width: 0; }

/* 人话：灰体小字——与下面蓝色胶囊在视觉上分成两层，避免读成表格 */
.arch-desc {
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
  margin-bottom: 8px;
}

.arch-tag {
  display: inline-block;
  margin-left: 8px;
  font-size: 11px;
  color: #2f6fd8;
  background: #eef4fe;
  border: 1px dashed #a9c6f5;
  border-radius: 4px;
  padding: 1px 7px;
}

/* 技术对应：胶囊标签 */
.arch-items {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;

  span {
    font-size: 12px;
    color: #5e6d82;
    background: #f2f6fc;
    border: 1px solid #e4ecf7;
    border-radius: 999px;
    padding: 4px 12px;
  }
}

/* 实时通道：横跨 L2/L3/L4 三行，虚线区别于层间的实线箭头 */
.arch-chan {
  grid-column: 2;
  grid-row: 2 / 5;
  display: flex;
  flex-direction: column;
  align-items: center;

  .arch-chan-label {
    font-size: 11px;
    line-height: 1.5;
    color: #3d8bfd;
    text-align: center;
  }

  .arch-chan-line {
    position: relative;
    flex: 1;
    margin-top: 6px;
    border-left: 2px dashed #7fb0f5;

    span {
      position: absolute;
      left: 50%;
      bottom: -1px;
      transform: translateX(-50%);
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 6px solid #7fb0f5;
    }
  }
}

/* 通道图例：实线=批量（经数据层）/ 虚线=实时（直连应用层） */
.arch-legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px 28px;
  max-width: 900px;
  margin: 18px auto 0;
  font-size: 12px;
  color: #909399;
}

.arch-legend-item {
  display: inline-flex;
  align-items: center;

  i {
    display: inline-block;
    width: 26px;
    height: 0;
    margin-right: 6px;
  }

  .arch-legend-solid { border-top: 2px solid #7fb0f5; }
  .arch-legend-dashed { border-top: 2px dashed #7fb0f5; }
}

/* ---------- 企业风貌 ---------- */

.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;

  .gallery-item {
    position: relative;
    border-radius: 10px;
    overflow: hidden;
    height: 180px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    transition: transform .25s ease, box-shadow .25s ease;

    &:hover {
      transform: translateY(-4px);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
    }

    img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .4s ease; }

    &:hover img { transform: scale(1.06); }

    .gallery-caption {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      padding: 18px 12px 8px;
      font-size: 12px;
      color: #fff;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
    }
  }
}

/* ---------- 响应式 ---------- */
@media (max-width: 768px) {
  .section .section-inner { flex-direction: column !important; gap: 20px; }
  .section .section-media { flex: none; width: 100%; }
  .feature-row { flex-direction: column; }
  .hero { height: 280px; clip-path: polygon(0 0, 100% 0, 100% calc(100% - 52px), 0 100%); }
  .hero .hero-title { font-size: 24px; }
  .hero .hero-scroll { display: none; }   /* 小屏高度紧张，去掉滚动提示 */
  .arch { grid-template-columns: 1fr; row-gap: 8px; }
  .arch-chan { display: none; }   /* 小屏放不下右侧分栏，双通道说明由图例承担 */
  .arch-layer { flex-direction: column; align-items: flex-start; gap: 10px; }
  .arch-label { flex: none; }
  .arch-legend { flex-direction: column; align-items: flex-start; gap: 6px; }
}
</style>
