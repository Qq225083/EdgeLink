<template>
  <div class="app-container">
    <!-- 查询条件 -->
    <el-form :model="queryParams" ref="queryForm" size="small" :inline="true" v-show="showSearch" label-width="80px">
      <el-form-item label="发布人" prop="publishBy">
        <el-input v-model="queryParams.publishBy" placeholder="模糊查询" clearable @keyup.enter.native="handleQuery" />
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

    <!-- 发布履历表格 -->
    <el-table v-loading="loading" :data="logList">
      <el-table-column label="发布时间" align="center" prop="publishTime" width="170" :show-overflow-tooltip="true" />
      <el-table-column label="发布人" align="center" prop="publishBy" width="110" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.publishBy || '-' }}</template>
      </el-table-column>
      <el-table-column label="设备数" align="center" prop="deviceCount" width="80" />
      <el-table-column label="节点数" align="center" prop="nodeCount" width="80" />
      <el-table-column label="IP数" align="center" prop="ipCount" width="80" />
      <el-table-column label="结果" align="center" prop="status" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.status === 'failed' ? 'danger' : (scope.row.status === 'partial' ? 'warning' : 'success')" size="mini">
            {{ scope.row.status === 'failed' ? '失败' : (scope.row.status === 'partial' ? '部分成功' : '成功') }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="失败明细" align="center" width="110">
        <template slot-scope="scope">
          <span v-if="!scope.row.failDetail || !scope.row.failDetail.length">-</span>
          <el-popover v-else trigger="hover" placement="top">
            <div v-for="f in scope.row.failDetail" :key="f.deviceId" style="font-size:12px">
              {{ f.deviceName || ('设备' + f.deviceId) }}（{{ f.hostPcIp }}）
            </div>
            <el-button slot="reference" type="text" size="mini">查看 {{ scope.row.failDetail.length }} 台</el-button>
          </el-popover>
        </template>
      </el-table-column>
      <el-table-column label="发布设备ID" align="center" prop="deviceIds" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ formatDeviceIds(scope.row.deviceIds) }}</template>
      </el-table-column>
      <el-table-column label="备注" align="center" prop="remark" width="200" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.remark || '-' }}</template>
      </el-table-column>
    </el-table>

    <!-- 分页 -->
    <pagination v-show="total>0" :total="total" :page.sync="queryParams.pageNum" :limit.sync="queryParams.pageSize" @pagination="getList" />
  </div>
</template>

<script>
import { listPublishLog } from "@/api/plc/publishLog";

export default {
  name: "PlcPublishLog",
  data() {
    return {
      loading: true,
      showSearch: true,
      total: 0,
      logList: [],
      queryParams: {
        pageNum: 1,
        pageSize: 10,
        publishBy: null,
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
      listPublishLog(this.queryParams).then(response => {
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
    /** 格式化设备ID列表 */
    formatDeviceIds(ids) {
      if (!ids) return '-';
      if (Array.isArray(ids)) return ids.join(', ');
      return String(ids);
    },
  }
};
</script>
