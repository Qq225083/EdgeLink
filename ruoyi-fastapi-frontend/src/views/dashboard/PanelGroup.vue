<template>
  <el-row :gutter="40" class="panel-group">
    <!-- 采集节点（在线/总计） -->
    <el-col :xs="12" :sm="12" :lg="6" class="card-panel-col">
      <div class="card-panel">
        <div class="card-panel-icon-wrapper icon-green">
          <svg-icon icon-class="tree" class-name="card-panel-icon" />
        </div>
        <div class="card-panel-description">
          <div class="card-panel-text">采集节点（在线/总计）</div>
          <div class="card-panel-num-wrapper">
            <count-to :start-val="0" :end-val="nodeOnline" :duration="2000" class="card-panel-num" />
            <span class="card-panel-total">/ {{ nodeTotal }}</span>
          </div>
        </div>
      </div>
    </el-col>
    <!-- PLC 设备（在线/总计） -->
    <el-col :xs="12" :sm="12" :lg="6" class="card-panel-col">
      <div class="card-panel">
        <div class="card-panel-icon-wrapper icon-blue">
          <svg-icon icon-class="cascader" class-name="card-panel-icon" />
        </div>
        <div class="card-panel-description">
          <div class="card-panel-text">PLC 设备（在线/总计）</div>
          <div class="card-panel-num-wrapper">
            <count-to :start-val="0" :end-val="plcOnline" :duration="2000" class="card-panel-num" />
            <span class="card-panel-total">/ {{ plcTotal }}</span>
          </div>
        </div>
      </div>
    </el-col>
    <!-- 今日采集（条数） -->
    <el-col :xs="12" :sm="12" :lg="6" class="card-panel-col">
      <div class="card-panel">
        <div class="card-panel-icon-wrapper icon-yellow">
          <svg-icon icon-class="chart" class-name="card-panel-icon" />
        </div>
        <div class="card-panel-description">
          <div class="card-panel-text">今日采集（{{ todayUnit }}）</div>
          <count-to :start-val="0" :end-val="todayCollect" :duration="2600" class="card-panel-num" />
        </div>
      </div>
    </el-col>
    <!-- 未处理告警：>0 时图标变红并闪烁 -->
    <el-col :xs="12" :sm="12" :lg="6" class="card-panel-col">
      <div class="card-panel" :class="{ 'card-panel-alert': alertCount > 0 }">
        <div class="card-panel-icon-wrapper" :class="alertCount > 0 ? 'icon-red blink' : 'icon-gray'">
          <svg-icon icon-class="message" class-name="card-panel-icon" />
        </div>
        <div class="card-panel-description">
          <div class="card-panel-text">未处理告警</div>
          <count-to :start-val="0" :end-val="alertCount" :duration="2000" class="card-panel-num" />
        </div>
      </div>
    </el-col>
  </el-row>
</template>

<script>
import CountTo from 'vue-count-to'

export default {
  components: {
    CountTo
  },
  // 数据全部由父组件（dashboard 首页）通过 props 传入，组件本身不取数
  props: {
    nodeOnline: { type: Number, default: 0 },
    nodeTotal: { type: Number, default: 0 },
    plcOnline: { type: Number, default: 0 },
    plcTotal: { type: Number, default: 0 },
    todayCollect: { type: Number, default: 0 },
    todayUnit: { type: String, default: '条' },
    alertCount: { type: Number, default: 0 }
  }
}
</script>

<style lang="scss" scoped>
.panel-group {
  margin-top: 18px;

  .card-panel-col {
    margin-bottom: 18px;
  }

  .card-panel {
    height: 108px;
    font-size: 12px;
    position: relative;
    overflow: hidden;
    color: #666;
    background: #fff;
    box-shadow: 4px 4px 40px rgba(0, 0, 0, .05);
    border-radius: 4px;

    // 告警激活：整卡淡红描边
    &.card-panel-alert {
      box-shadow: 0 0 0 1px rgba(245, 108, 108, .35), 4px 4px 40px rgba(0, 0, 0, .05);
    }

    .card-panel-icon-wrapper {
      float: left;
      margin: 14px 0 0 14px;
      padding: 16px;
      transition: all 0.38s ease-out;
      border-radius: 6px;

      &.icon-green  { color: #67c23a; background: rgba(103, 194, 58, .1); }
      &.icon-blue   { color: #409eff; background: rgba(64, 158, 255, .1); }
      &.icon-yellow { color: #e6a23c; background: rgba(230, 162, 60, .1); }
      &.icon-gray   { color: #909399; background: rgba(144, 147, 153, .1); }
      &.icon-red    { color: #f56c6c; background: rgba(245, 108, 108, .12); }
    }

    // 告警未处理时的闪烁动画
    .blink {
      animation: blink-anim 1.2s ease-in-out infinite;
    }

    .card-panel-icon {
      float: left;
      font-size: 48px;
    }

    .card-panel-description {
      float: right;
      font-weight: bold;
      margin: 26px;
      margin-left: 0;

      .card-panel-text {
        line-height: 18px;
        color: rgba(0, 0, 0, 0.45);
        font-size: 15px;
        margin-bottom: 10px;
      }

      .card-panel-num-wrapper {
        line-height: 1;
      }

      .card-panel-num {
        font-size: 22px;
      }

      .card-panel-total {
        font-size: 14px;
        color: #909399;
        margin-left: 4px;
      }
    }
  }
}

@keyframes blink-anim {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}

@media (max-width: 550px) {
  .card-panel-description {
    margin: 18px 12px !important;
  }

  .card-panel-icon-wrapper {
    padding: 10px !important;
    margin: 14px 0 0 10px !important;

    .card-panel-icon {
      font-size: 36px !important;
    }
  }
}
</style>
