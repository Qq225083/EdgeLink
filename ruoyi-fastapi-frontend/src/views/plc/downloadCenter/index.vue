<template>
  <div class="app-container">
    <el-alert
      title="现场部署请先下载对应安装包，按附带的安装说明操作；如需历史版本请联系管理员。"
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
    />
    <div class="toolbar">
      <el-radio-group v-model="downloadGroup" size="small" @change="loadDownloadList">
        <el-radio-button label="">全部</el-radio-button>
        <el-radio-button v-for="g in groupOptions" :key="g.value" :label="g.value">{{ g.label }}</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="downloadKeyword"
        placeholder="名称/描述关键字"
        clearable
        size="small"
        style="width: 240px; margin-left: 12px"
        @keyup.enter.native="loadDownloadList"
        @clear="loadDownloadList"
      />
      <el-button type="primary" icon="el-icon-search" size="mini" style="margin-left: 8px" @click="loadDownloadList">搜索</el-button>
    </div>

    <el-table v-loading="downloadLoading" :data="downloadList" size="small" border>
      <el-table-column label="交付物" min-width="180" :show-overflow-tooltip="true">
        <template slot-scope="scope">
          <span class="item-name">{{ scope.row.name }}</span>
          <el-tag size="mini" type="success" effect="plain" style="margin-left:6px">v{{ scope.row.version || '-' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="类别" width="120" align="center">
        <template slot-scope="scope">{{ groupLabel(scope.row.groupKey) }}</template>
      </el-table-column>
      <el-table-column label="描述" min-width="220" prop="description" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.description || '-' }}</template>
      </el-table-column>
      <el-table-column label="大小" width="90" align="center">
        <template slot-scope="scope">{{ formatSize(scope.row.sizeBytes) }}</template>
      </el-table-column>
      <el-table-column label="上传人" width="90" align="center">
        <template slot-scope="scope">{{ scope.row.createBy || '-' }}</template>
      </el-table-column>
      <el-table-column label="更新时间" width="150" align="center">
        <template slot-scope="scope">{{ formatTime(scope.row.updateTime) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="110" align="center">
        <template slot-scope="scope">
          <el-button
            type="primary" size="mini" icon="el-icon-download"
            :loading="downloadingId === scope.row.id"
            @click="handleDownload(scope.row)"
          >下载</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div v-if="!downloadLoading && !downloadList.length" class="empty-tip">暂无交付物，发版后自动上架</div>
  </div>
</template>

<script>
import { listDownloads } from "@/api/plc/downloadCenter";

export default {
  name: "DownloadCenterIndex",
  data() {
    return {
      groupOptions: [
        { label: '自研节点包', value: 'packages' },
        { label: '完整部署包', value: 'nodered-full' },
        { label: '增量部署包', value: 'nodered-inc' },
        { label: '文档手册', value: 'docs' },
        { label: '通用资料', value: 'common' },
      ],
      downloadGroup: '',
      downloadKeyword: '',
      downloadLoading: false,
      downloadList: [],
      downloadingId: null,
    };
  },
  created() {
    this.loadDownloadList();
  },
  methods: {
    groupLabel(key) {
      const g = this.groupOptions.find(x => x.value === key);
      return g ? g.label : key;
    },
    /** 下载中心列表（只显示上架） */
    loadDownloadList() {
      this.downloadLoading = true;
      listDownloads({ group: this.downloadGroup || undefined, keyword: this.downloadKeyword || undefined, status: 1 })
        .then(res => { this.downloadList = res.data || []; this.downloadLoading = false; })
        .catch(() => { this.downloadLoading = false; });
    },
    handleDownload(row) {
      this.downloadingId = row.id;
      // 下载文件名：优先原始文件名（不带时间戳前缀），兜底存盘名
      const saveName = row.originName || row.fileName.split('/').pop();
      this.$download.zip('/common/download/package?id=' + row.id, saveName);
      setTimeout(() => {
        this.downloadingId = null;
        this.$message.success('下载已开始，请检查浏览器下载栏');
      }, 1000);
    },
    formatSize(bytes) {
      if (!bytes) return '-';
      if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
      if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return bytes + ' B';
    },
    formatTime(val) {
      if (!val) return '-';
      const t = String(val).replace('T', ' ').split('.')[0].replace(/\+.*$/, '');
      return t.slice(0, 19);
    },
  },
};
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  margin-bottom: 14px;
}
.item-name {
  font-weight: bold;
  color: #303133;
}
.empty-tip {
  text-align: center;
  color: #c0c4cc;
  font-size: 13px;
  padding: 30px 0;
}
</style>
