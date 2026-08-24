<template>
  <div class="app-container">
    <!-- 查询条件 -->
    <el-form :model="queryParams" ref="queryForm" size="small" :inline="true" v-show="showSearch" label-width="80px">
      <el-form-item label="对象类型" prop="targetType">
        <el-select v-model="queryParams.targetType" placeholder="全部" clearable style="width: 120px">
          <el-option label="设备" value="device" />
          <el-option label="点位" value="tag" />
        </el-select>
      </el-form-item>
      <el-form-item label="对象名称" prop="targetName">
        <el-input v-model="queryParams.targetName" placeholder="模糊查询" clearable style="width: 150px" @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="操作人" prop="changeBy">
        <el-input v-model="queryParams.changeBy" placeholder="模糊查询" clearable style="width: 120px" @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="操作类型" prop="changeType">
        <el-select v-model="queryParams.changeType" placeholder="全部" clearable style="width: 120px">
          <el-option label="新增" value="add" />
          <el-option label="修改" value="update" />
          <el-option label="启用" value="enable" />
          <el-option label="停用" value="disable" />
          <el-option label="删除" value="delete" />
        </el-select>
      </el-form-item>
      <el-form-item label="开始日期" prop="startTime">
        <el-date-picker v-model="queryParams.startTime" type="date" value-format="yyyy-MM-dd" placeholder="开始日期" clearable style="width: 150px" />
      </el-form-item>
      <el-form-item label="结束日期" prop="endTime">
        <el-date-picker v-model="queryParams.endTime" type="date" value-format="yyyy-MM-dd" placeholder="结束日期" clearable style="width: 150px" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="el-icon-search" size="mini" @click="handleQuery">搜索</el-button>
        <el-button icon="el-icon-refresh" size="mini" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <!-- 操作按钮栏 -->
    <el-row :gutter="10" class="mb8">
      <right-toolbar :showSearch.sync="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <!-- 修改履历表格 -->
    <el-table v-loading="loading" :data="logList">
      <el-table-column label="操作时间" align="center" prop="changeTime" width="170" :show-overflow-tooltip="true" />
      <el-table-column label="操作人" align="center" prop="changeBy" width="100" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.changeBy || '-' }}</template>
      </el-table-column>
      <el-table-column label="对象类型" align="center" prop="targetType" width="90">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.targetType === 'device'" size="mini">设备</el-tag>
          <el-tag v-else-if="scope.row.targetType === 'tag'" type="success" size="mini">点位</el-tag>
          <el-tag v-else type="info" size="mini">{{ scope.row.targetType }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="对象名称" align="center" prop="targetName" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.targetName || '-' }}</template>
      </el-table-column>
      <el-table-column label="操作类型" align="center" prop="changeType" width="90">
        <template slot-scope="scope">
          <el-tag :type="changeTypeTag(scope.row.changeType)" size="mini">{{ changeTypeLabel(scope.row.changeType) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="变更摘要" align="center" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ changeSummary(scope.row) }}</template>
      </el-table-column>
      <el-table-column label="备注" align="center" prop="remark" width="180" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.remark || '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" align="center" class-name="small-padding fixed-width" width="90">
        <template slot-scope="scope">
          <el-button size="mini" type="text" icon="el-icon-view" @click="handleDetail(scope.row)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 分页 -->
    <pagination v-show="total>0" :total="total" :page.sync="queryParams.pageNum" :limit.sync="queryParams.pageSize" @pagination="getList" />

    <!-- 变更详情对话框 -->
    <el-dialog title="变更详情" :visible.sync="detailOpen" width="70%" append-to-body>
      <el-descriptions :column="2" border size="small" v-if="detailRow">
        <el-descriptions-item label="操作时间">{{ detailRow.changeTime }}</el-descriptions-item>
        <el-descriptions-item label="操作人">{{ detailRow.changeBy || '-' }}</el-descriptions-item>
        <el-descriptions-item label="对象类型">{{ detailRow.targetType === 'device' ? '设备' : (detailRow.targetType === 'tag' ? '点位' : detailRow.targetType) }}</el-descriptions-item>
        <el-descriptions-item label="对象名称">{{ detailRow.targetName || '-' }}（ID: {{ detailRow.targetId }}）</el-descriptions-item>
        <el-descriptions-item label="操作类型">{{ changeTypeLabel(detailRow.changeType) }}</el-descriptions-item>
        <el-descriptions-item label="备注">{{ detailRow.remark || '-' }}</el-descriptions-item>
      </el-descriptions>
      <el-row :gutter="10" style="margin-top: 10px">
        <el-col :span="12">
          <div class="json-title">变更前</div>
          <pre class="json-view">{{ formatJson(detailRow && detailRow.beforeValue) }}</pre>
        </el-col>
        <el-col :span="12">
          <div class="json-title">变更后</div>
          <pre class="json-view">{{ formatJson(detailRow && detailRow.afterValue) }}</pre>
        </el-col>
      </el-row>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="detailOpen = false">关 闭</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script>
import { listChangeLog } from "@/api/plc/changeLog";

export default {
  name: "PlcChangeLog",
  data() {
    return {
      loading: true,
      showSearch: true,
      total: 0,
      logList: [],
      detailOpen: false,
      detailRow: null,
      queryParams: {
        pageNum: 1,
        pageSize: 10,
        targetType: null,
        targetName: null,
        changeBy: null,
        changeType: null,
        startTime: null,
        endTime: null,
      },
    };
  },
  created() {
    this.getList();
  },
  methods: {
    /** 查询列表 */
    getList() {
      this.loading = true;
      listChangeLog(this.queryParams).then(response => {
        this.logList = response.rows || [];
        this.total = response.total || 0;
        this.loading = false;
      }).catch(() => {
        this.loading = false;
      });
    },
    /** 搜索 */
    handleQuery() {
      this.queryParams.pageNum = 1;
      this.getList();
    },
    /** 重置 */
    resetQuery() {
      this.resetForm("queryForm");
      this.handleQuery();
    },
    /** 操作类型标签颜色 */
    changeTypeTag(type) {
      const map = { add: 'success', update: 'warning', enable: 'primary', disable: 'info', delete: 'danger' };
      return map[type] || 'info';
    },
    /** 操作类型中文名 */
    changeTypeLabel(type) {
      const map = { add: '新增', update: '修改', enable: '启用', disable: '停用', delete: '删除' };
      return map[type] || type || '-';
    },
    /** 变更摘要：展示变更后值的字段名 */
    changeSummary(row) {
      if (row.remark) return row.remark;
      const after = row.afterValue;
      if (after && typeof after === 'object') {
        const keys = Object.keys(after).filter(k => k !== '_raw');
        if (keys.length) return '变更字段: ' + keys.join(', ');
      }
      return '-';
    },
    /** 查看详情 */
    handleDetail(row) {
      this.detailRow = row;
      this.detailOpen = true;
    },
    /** 格式化 JSON 展示 */
    formatJson(val) {
      if (val === null || val === undefined || val === '') return '（无）';
      if (typeof val === 'string') {
        try {
          return JSON.stringify(JSON.parse(val), null, 2);
        } catch (e) {
          return val;
        }
      }
      try {
        return JSON.stringify(val, null, 2);
      } catch (e) {
        return String(val);
      }
    },
  }
};
</script>

<style scoped>
.json-title {
  font-weight: bold;
  margin-bottom: 5px;
}
.json-view {
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  padding: 10px;
  max-height: 400px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
