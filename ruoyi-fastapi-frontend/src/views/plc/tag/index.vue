<template>
  <div class="app-container">
    <!-- 查询条件：跨设备 -->
    <el-form :model="queryParams" ref="queryForm" size="small" :inline="true" v-show="showSearch" label-width="100px">
      <el-form-item label="点位名称" prop="tagName">
        <el-input v-model="queryParams.tagName" placeholder="模糊" clearable @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="寄存器类型" prop="registerType">
        <el-select v-model="queryParams.registerType" placeholder="全部" clearable>
          <!-- 三菱 MC -->
          <el-option label="D" value="D" /><el-option label="W" value="W" />
          <el-option label="X" value="X" /><el-option label="Y" value="Y" /><el-option label="M" value="M" />
          <el-option label="L" value="L" /><el-option label="B" value="B" /><el-option label="R" value="R" />
          <!-- Modbus -->
          <el-option label="HR" value="HR" /><el-option label="IR" value="IR" />
          <el-option label="CR" value="CR" /><el-option label="COIL" value="COIL" /><el-option label="DISCRETE" value="DISCRETE" />
        </el-select>
      </el-form-item>
      <el-form-item label="寄存器地址" prop="registerAddress">
        <el-input v-model="queryParams.registerAddress" placeholder="精确" clearable @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="设备名称" prop="deviceName">
        <el-input v-model="queryParams.deviceName" placeholder="模糊" clearable @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="状态" prop="status">
        <el-select v-model="queryParams.status" placeholder="全部" clearable>
          <el-option label="启用" value="0" /><el-option label="停用" value="1" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="el-icon-search" size="mini" @click="handleQuery">搜索</el-button>
        <el-button icon="el-icon-refresh" size="mini" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <!-- 工具栏 -->
    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="primary" icon="el-icon-edit" size="mini" :disabled="multiple" @click="handleBatchUpdate" v-hasPermi="['plc:tag:edit']">批量修改</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="warning" icon="el-icon-download" size="mini" @click="handleExport" v-hasPermi="['plc:tag:list']">导出</el-button>
      </el-col>
      <right-toolbar :showSearch.sync="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <!-- 点位表格 -->
    <el-table v-loading="loading" :data="tagList" @selection-change="handleSelectionChange" ref="tagTable">
      <el-table-column type="selection" width="55" align="center" />
      <el-table-column label="设备名称" align="center" prop="deviceName" width="140" :show-overflow-tooltip="true" />
      <el-table-column label="点位名称" align="center" prop="tagName" width="140" :show-overflow-tooltip="true" />
      <el-table-column label="寄存器类型" align="center" prop="registerType" width="90">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.registerType === 'CALC'" type="warning" size="small">计算·{{ scope.row.calcOp }}</el-tag>
          <span v-else>{{ scope.row.registerType }}</span>
        </template>
      </el-table-column>
      <el-table-column label="地址" align="center" prop="registerAddress" width="100" />
      <el-table-column label="数据类型" align="center" prop="dataType" width="90" />
      <el-table-column label="单位" align="center" prop="unit" width="70" />
      <el-table-column label="描述" align="center" prop="description" :show-overflow-tooltip="true" width="150" />
      <el-table-column label="状态" align="center" prop="tagStatus" width="65">
        <template slot-scope="scope">
          <!-- 注意：全局接口 status=设备状态、tagStatus=点位自身状态，开关必须绑 tagStatus -->
          <el-switch v-model="scope.row.tagStatus" active-value="0" inactive-value="1" @change="handleStatusChange(scope.row)" />
        </template>
      </el-table-column>
      <el-table-column label="设备状态" align="center" prop="status" width="80">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.status === '1'" type="danger" size="mini">设备已停用</el-tag>
          <span v-else style="color:#67c23a;font-size:12px">正常</span>
        </template>
      </el-table-column>
      <el-table-column label="排序" align="center" prop="sortOrder" width="55" />
    </el-table>

    <pagination v-show="total>0" :total="total" :page.sync="queryParams.pageNum" :limit.sync="queryParams.pageSize" @pagination="getList" />

    <!-- 批量修改弹窗 -->
    <el-dialog title="批量修改点位" :visible.sync="batchOpen" width="90%" :class="'dialog-sm'" append-to-body>
      <el-form ref="batchForm" :model="batchForm" label-width="100px">
        <el-alert :title="'已选中 ' + ids.length + ' 个点位'" type="info" :closable="false" style="margin-bottom: 15px" />
        <el-form-item label="寄存器类型">
          <el-select v-model="batchForm.registerType" placeholder="不修改" clearable style="width: 100%">
            <!-- 三菱 MC -->
            <el-option label="D" value="D" /><el-option label="W" value="W" />
            <el-option label="X" value="X" /><el-option label="Y" value="Y" /><el-option label="M" value="M" />
            <el-option label="L" value="L" /><el-option label="B" value="B" /><el-option label="R" value="R" />
            <!-- Modbus -->
            <el-option label="HR" value="HR" /><el-option label="IR" value="IR" />
            <el-option label="CR" value="CR" /><el-option label="COIL" value="COIL" /><el-option label="DISCRETE" value="DISCRETE" />
          </el-select>
        </el-form-item>
        <el-form-item label="数据类型">
          <el-select v-model="batchForm.dataType" placeholder="不修改" clearable style="width: 100%">
            <el-option label="BIT" value="BIT" /><el-option label="BOOL" value="BOOL" />
            <el-option label="INT16" value="INT16" /><el-option label="UINT16" value="UINT16" />
            <el-option label="INT32" value="INT32" /><el-option label="UINT32" value="UINT32" />
            <el-option label="FLOAT" value="FLOAT" /><el-option label="DOUBLE" value="DOUBLE" />
          </el-select>
        </el-form-item>
        <el-form-item label="单位">
          <el-input v-model="batchForm.unit" placeholder="不修改则留空" clearable />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="batchForm.status" placeholder="不修改" clearable style="width: 100%">
            <el-option label="启用" value="0" /><el-option label="停用" value="1" />
          </el-select>
        </el-form-item>
        <el-form-item label="换算类型">
          <el-select v-model="batchForm.transformType" placeholder="不修改" clearable style="width: 100%">
            <el-option label="none" value="none" /><el-option label="linear" value="linear" />
            <el-option label="slope_offset" value="slope_offset" />
          </el-select>
        </el-form-item>
        <el-form-item label="斜率/乘数">
          <el-input-number v-model="batchForm.transformSlopeA" placeholder="不修改则留空" style="width: 100%" />
        </el-form-item>
        <el-form-item label="偏移量">
          <el-input-number v-model="batchForm.transformOffsetB" placeholder="不修改则留空" style="width: 100%" />
        </el-form-item>
        <el-form-item label="工程单位">
          <el-input v-model="batchForm.engUnit" placeholder="不修改则留空" clearable />
        </el-form-item>
        <el-form-item label="死区(数值)">
          <el-input-number v-model="batchForm.reportDeadbandMs" placeholder="不修改则留空" :min="0" style="width: 100%" />
        </el-form-item>
        <el-form-item label="强制上报间隔(ms)">
          <el-input-number v-model="batchForm.reportForceIntervalMs" placeholder="不修改则留空" :min="0" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" @click="submitBatchUpdate">确 定</el-button>
        <el-button @click="batchOpen = false">取 消</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script>
import { listTagGlobal, batchUpdateTags, toggleTagStatus } from "@/api/plc/tag";
import { download } from "@/utils/request";

export default {
  name: "PlcTagGlobal",
  data() {
    return {
      loading: true,
      ids: [],
      multiple: true,
      showSearch: true,
      total: 0,
      tagList: [],
      queryParams: {
        pageNum: 1, pageSize: 10,
        tagName: null, registerType: null, registerAddress: null,
        deviceName: null, status: null,
      },
      batchOpen: false,
      batchForm: { registerType: null, dataType: null, unit: null, status: null, transformType: null, transformSlopeA: null, transformOffsetB: null, engUnit: null, reportDeadbandMs: null, reportForceIntervalMs: null },
    };
  },
  created() { this.getList(); },
  methods: {
    getList() {
      this.loading = true;
      listTagGlobal(this.queryParams).then(response => {
        this.tagList = (response.rows || []).map(item => {
          // 规范化 status 为字符串（el-switch active-value/inactive-value 要求字符串类型）
          // 注意：全局接口 status=设备状态、tagStatus=点位自身状态，两个都要规范化
          item.status = String(item.status ?? '0')
          item.tagStatus = String(item.tagStatus ?? '0')
          return item
        });
        this.total = response.total;
        this.loading = false;
      }).catch(() => {
        this.loading = false;
      });
    },
    handleQuery() { this.queryParams.pageNum = 1; this.getList(); },
    resetQuery() { this.resetForm("queryForm"); this.handleQuery(); },
    handleSelectionChange(selection) {
      this.ids = selection.map(item => item.id);
      this.multiple = !selection.length;
    },
    handleBatchUpdate() {
      this.batchForm = { registerType: null, dataType: null, unit: null, status: null, transformType: null, transformSlopeA: null, transformOffsetB: null, engUnit: null, reportDeadbandMs: null, reportForceIntervalMs: null };
      this.batchOpen = true;
    },
    handleStatusChange(row) {
      const newStatus = row.tagStatus;
      const oldStatus = newStatus === '0' ? '1' : '0';
      toggleTagStatus(row.id, newStatus).then(() => {
        this.$modal.msgSuccess((newStatus === '0' ? '已启用' : '已停用') + '，发布中心发布后生效');
      }).catch(() => {
        row.tagStatus = oldStatus;
        this.$modal.msgError('状态切换失败');
      });
    },
    submitBatchUpdate() {
      const hasValue = Object.values(this.batchForm).some(v => v !== null && v !== '');
      if (!hasValue) { this.$modal.msgWarning("至少选择一个要修改的字段"); return; }
      batchUpdateTags({ ids: this.ids.join(','), ...this.batchForm }).then(response => {
        this.$modal.msgSuccess((response.msg || '批量修改成功') + '，请前往【配置发布中心】下发到采集节点');
        this.batchOpen = false;
        this.getList();
      });
    },
    /** 导出点位列表 */
    handleExport() {
      download('plc/tag/export', { ...this.queryParams }, `plc_tag_${new Date().getTime()}.xlsx`);
    },
  },
};
</script>

<style lang="scss" scoped>
/* ======== 移动端 & 响应式适配 ======== */

/* 工具栏按钮换行 */
.toolbar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}

/* 对话框宽度限制 */
::v-deep .dialog-sm .el-dialog { max-width: 520px; }

/* 表格横向滚动 */
::v-deep .el-table {
  min-width: 750px;
}

/* 移动端适配 */
@media screen and (max-width: 768px) {
  /* 搜索表单垂直排列 */
  ::v-deep .el-form--inline .el-form-item {
    display: block;
    margin-right: 0;
    margin-bottom: 10px;
  }
  ::v-deep .el-form--inline .el-form-item__content {
    width: 100%;
  }

  /* 对话框全宽 */
  ::v-deep .el-dialog {
    width: 96% !important;
    margin: 10px auto !important;
  }

  /* 页面容器可滚动 */
  .app-container {
    overflow-x: auto;
  }
}
</style>
