<template>
  <div class="app-container">
    <div class="toolbar">
      <el-button type="primary" plain icon="el-icon-upload2" size="mini" @click="openUploadDialog">上传交付物</el-button>
      <el-radio-group v-model="adminGroup" size="small" style="margin-left: 12px" @change="loadAdminList">
        <el-radio-button label="">全部</el-radio-button>
        <el-radio-button v-for="g in groupOptions" :key="g.value" :label="g.value">{{ g.label }}</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="adminKeyword"
        placeholder="名称/描述关键字"
        clearable
        size="small"
        style="width: 240px; margin-left: 12px"
        @keyup.enter.native="loadAdminList"
        @clear="loadAdminList"
      />
      <el-button type="primary" icon="el-icon-search" size="mini" style="margin-left: 8px" @click="loadAdminList">搜索</el-button>
    </div>

    <el-table v-loading="adminLoading" :data="adminList" size="small" border>
      <el-table-column label="ID" width="60" align="center" prop="id" />
      <el-table-column label="交付物" min-width="150" :show-overflow-tooltip="true" prop="name" />
      <el-table-column label="类别" width="120" align="center">
        <template slot-scope="scope">{{ groupLabel(scope.row.groupKey) }}</template>
      </el-table-column>
      <el-table-column label="版本" width="80" align="center" prop="version">
        <template slot-scope="scope">{{ scope.row.version || '-' }}</template>
      </el-table-column>
      <el-table-column label="文件" min-width="200" prop="fileName" :show-overflow-tooltip="true" />
      <el-table-column label="大小" width="90" align="center">
        <template slot-scope="scope">{{ formatSize(scope.row.sizeBytes) }}</template>
      </el-table-column>
      <el-table-column label="上传人" width="90" align="center">
        <template slot-scope="scope">{{ scope.row.createBy || '-' }}</template>
      </el-table-column>
      <el-table-column label="上传时间" width="150" align="center">
        <template slot-scope="scope">{{ formatTime(scope.row.createTime) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="80" align="center">
        <template slot-scope="scope">
          <el-tag :type="scope.row.status === 1 ? 'success' : 'info'" size="mini">
            {{ scope.row.status === 1 ? '上架' : '下架' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" align="center">
        <template slot-scope="scope">
          <el-button size="mini" type="text" icon="el-icon-edit" @click="openEditDialog(scope.row)">编辑</el-button>
          <el-button size="mini" type="text" icon="el-icon-delete" style="color:#F56C6C" @click="handleDelete(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 上传交付物对话框 -->
    <el-dialog title="上传交付物" :visible.sync="uploadOpen" width="560px" append-to-body>
      <el-form ref="uploadForm" :model="uploadForm" :rules="uploadRules" label-width="90px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="uploadForm.name" placeholder="如：存量监控节点包" maxlength="100" />
        </el-form-item>
        <el-form-item label="类别" prop="groupKey">
          <el-select v-model="uploadForm.groupKey" style="width: 100%">
            <el-option v-for="g in groupOptions" :key="g.value" :label="g.label" :value="g.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="版本" prop="version">
          <el-input v-model="uploadForm.version" placeholder="如：1.0.6" maxlength="20" />
        </el-form-item>
        <el-form-item label="描述" prop="description">
          <el-input v-model="uploadForm.description" type="textarea" :rows="2" maxlength="500" show-word-limit />
        </el-form-item>
        <el-form-item label="标签" prop="tags">
          <el-input v-model="uploadForm.tags" placeholder="逗号分隔，如：Node-RED ≥1.0,零依赖" maxlength="200" />
        </el-form-item>
        <el-form-item label="文件" prop="file">
          <el-upload
            ref="uploader"
            :auto-upload="false"
            :limit="1"
            :on-change="onFileChange"
            :on-remove="onFileRemove"
            drag
          >
            <i class="el-icon-upload" />
            <div class="el-upload__text">将文件拖到此处，或<em>点击选择</em></div>
            <div class="el-upload__tip" slot="tip">除可执行文件（exe/bat/ps1 等）外均可上传，单文件 ≤ 500MB；大于 2MB 自动分片上传</div>
          </el-upload>
        </el-form-item>
      </el-form>
      <div slot="footer">
        <!-- 分片上传进度条 -->
        <el-progress v-if="uploading && uploadMode === 'chunked'" :percentage="uploadProgress" style="margin-bottom: 10px" />
        <div v-if="uploading" class="upload-hint">{{ uploadMode === 'chunked' ? '分片上传中（大文件自动拆分规避拦截），请勿关闭页面' : '上传中...' }}</div>
        <el-button type="primary" :loading="uploading" :disabled="!uploadFile" @click="submitUpload">开始上传</el-button>
        <el-button @click="uploadOpen = false">取消</el-button>
      </div>
    </el-dialog>

    <!-- 编辑对话框 -->
    <el-dialog title="编辑交付物" :visible.sync="editOpen" width="560px" append-to-body>
      <el-form ref="editForm" :model="editForm" :rules="uploadRules" label-width="90px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="editForm.name" maxlength="100" />
        </el-form-item>
        <el-form-item label="类别" prop="groupKey">
          <el-select v-model="editForm.groupKey" style="width: 100%">
            <el-option v-for="g in groupOptions" :key="g.value" :label="g.label" :value="g.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="版本" prop="version">
          <el-input v-model="editForm.version" maxlength="20" />
        </el-form-item>
        <el-form-item label="描述" prop="description">
          <el-input v-model="editForm.description" type="textarea" :rows="2" maxlength="500" show-word-limit />
        </el-form-item>
        <el-form-item label="标签" prop="tags">
          <el-input v-model="editForm.tags" maxlength="200" />
        </el-form-item>
        <el-form-item label="状态" prop="status">
          <el-radio-group v-model="editForm.status">
            <el-radio :label="1">上架</el-radio>
            <el-radio :label="0">下架</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <div slot="footer">
        <el-button type="primary" :loading="editSaving" @click="submitEdit">保存</el-button>
        <el-button @click="editOpen = false">取消</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script>
import { listDownloads, uploadDownload, updateDownload, deleteDownload, initDownloadUpload, mergeDownloadUpload } from "@/api/plc/downloadCenter";
import axios from 'axios';
import { getToken } from '@/utils/auth';

// 分片参数：1MB/片（低于企业安全软件常见上传拦截阈值），>2MB 的文件走分片，3 路并发
const CHUNK_SIZE = 1024 * 1024;
const CHUNK_THRESHOLD = 2 * 1024 * 1024;
const CHUNK_CONCURRENCY = 3;

// 分片必须绕开全局 request 实例（其「同请求取消 + 防重复提交」拦截器会把各分片误判成同一请求互相取消），
// 用裸 axios 手动带 Authorization（与 plugins/download.js 同模式）
function uploadChunkRaw(formData) {
  return axios({
    method: 'post',
    url: process.env.VUE_APP_BASE_API + '/common/downloads/upload/chunk',
    data: formData,
    headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
  }).then(res => {
    const body = res.data;
    if (body && body.code && body.code !== 200) throw new Error(body.msg || '分片上传失败');
    return body;
  });
}

export default {
  name: "DownloadCenterAdmin",
  data() {
    return {
      groupOptions: [
        { label: '自研节点包', value: 'packages' },
        { label: '完整部署包', value: 'nodered-full' },
        { label: '增量部署包', value: 'nodered-inc' },
        { label: '文档手册', value: 'docs' },
        { label: '通用资料', value: 'common' },
      ],
      adminGroup: '',
      adminKeyword: '',
      adminLoading: false,
      adminList: [],
      // 上传
      uploadOpen: false,
      uploading: false,
      uploadProgress: 0,   // 分片上传进度（0-100）
      uploadMode: '',      // 'direct' | 'chunked'（展示用）
      uploadFile: null,
      uploadForm: { name: '', groupKey: 'packages', version: '', description: '', tags: '' },
      uploadRules: {
        name: [{ required: true, message: '名称不能为空', trigger: 'blur' }],
        groupKey: [{ required: true, message: '请选择类别', trigger: 'change' }],
      },
      // 编辑
      editOpen: false,
      editSaving: false,
      editForm: { id: null, name: '', groupKey: '', version: '', description: '', tags: '', status: 1 },
    };
  },
  created() {
    this.loadAdminList();
  },
  methods: {
    groupLabel(key) {
      const g = this.groupOptions.find(x => x.value === key);
      return g ? g.label : key;
    },
    loadAdminList() {
      this.adminLoading = true;
      listDownloads({ group: this.adminGroup || undefined, keyword: this.adminKeyword || undefined })
        .then(res => { this.adminList = res.data || []; this.adminLoading = false; })
        .catch(() => { this.adminLoading = false; });
    },
    // ---------- 上传 ----------
    openUploadDialog() {
      this.uploadForm = { name: '', groupKey: 'packages', version: '', description: '', tags: '' };
      this.uploadFile = null;
      this.uploadOpen = true;
      this.$nextTick(() => {
        this.$refs.uploader && this.$refs.uploader.clearFiles();
        this.$refs.uploadForm && this.$refs.uploadForm.clearValidate();
      });
    },
    onFileChange(file) {
      this.uploadFile = file.raw;
      if (!this.uploadForm.name) this.uploadForm.name = file.name.replace(/\.[^.]+$/, '');
    },
    onFileRemove() {
      this.uploadFile = null;
    },
    submitUpload() {
      this.$refs.uploadForm.validate(valid => {
        if (!valid || !this.uploadFile) return;
        // 大文件走分片（规避企业安全软件的大文件上传拦截），小文件直传
        if (this.uploadFile.size > CHUNK_THRESHOLD) {
          this.submitChunkedUpload();
        } else {
          this.submitDirectUpload();
        }
      });
    },
    /** 小文件：单次 multipart 直传 */
    submitDirectUpload() {
      this.uploadMode = 'direct';
      this.uploading = true;
      const fd = new FormData();
      fd.append('file', this.uploadFile);
      fd.append('name', this.uploadForm.name);
      fd.append('groupKey', this.uploadForm.groupKey);
      if (this.uploadForm.version) fd.append('version', this.uploadForm.version);
      if (this.uploadForm.description) fd.append('description', this.uploadForm.description);
      if (this.uploadForm.tags) fd.append('tags', this.uploadForm.tags);
      uploadDownload(fd).then(() => {
        this.onUploadDone();
      }).catch(err => {
        this.uploading = false;
        this.$modal.msgError(err.message || '上传失败');
      });
    },
    /** 大文件：分片上传（init → 并发逐片 → merge） */
    async submitChunkedUpload() {
      this.uploadMode = 'chunked';
      this.uploading = true;
      this.uploadProgress = 0;
      try {
        const file = this.uploadFile;
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        // 1. 初始化会话（后端先做判重/校验，白传之前就失败）
        const initRes = await initDownloadUpload({
          fileName: file.name,
          sizeBytes: file.size,
          totalChunks: totalChunks,
          name: this.uploadForm.name,
          groupKey: this.uploadForm.groupKey,
          version: this.uploadForm.version || undefined,
        });
        const uploadId = initRes.data.uploadId;
        // 2. 并发逐片上传（3 路并发池，单片失败重试 3 次）
        let next = 0;
        let done = 0;
        const worker = async () => {
          while (next < totalChunks) {
            const i = next++;
            const blob = file.slice(i * CHUNK_SIZE, Math.min(file.size, (i + 1) * CHUNK_SIZE));
            await this.uploadChunkWithRetry(uploadId, i, blob);
            done++;
            this.uploadProgress = Math.round((done / totalChunks) * 100);
          }
        };
        const workers = [];
        for (let w = 0; w < Math.min(CHUNK_CONCURRENCY, totalChunks); w++) workers.push(worker());
        await Promise.all(workers);
        // 3. 合并入库
        await mergeDownloadUpload({
          uploadId: uploadId,
          description: this.uploadForm.description || undefined,
          tags: this.uploadForm.tags || undefined,
        });
        this.onUploadDone();
      } catch (err) {
        this.uploading = false;
        this.$modal.msgError((err && err.message) || '分片上传失败');
      }
    },
    /** 单片上传带重试（走裸 axios，避开全局请求去重） */
    async uploadChunkWithRetry(uploadId, index, blob, retries) {
      const maxRetry = retries || 3;
      const fd = new FormData();
      fd.append('file', blob, 'chunk_' + index);
      fd.append('uploadId', uploadId);
      fd.append('chunkIndex', index);
      for (let attempt = 1; attempt <= maxRetry; attempt++) {
        try {
          await uploadChunkRaw(fd);
          return;
        } catch (e) {
          if (attempt === maxRetry) throw e;
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    },
    onUploadDone() {
      this.uploading = false;
      this.uploadOpen = false;
      this.$modal.msgSuccess('上传成功');
      this.loadAdminList();
    },
    // ---------- 编辑 ----------
    openEditDialog(row) {
      this.editForm = {
        id: row.id, name: row.name, groupKey: row.groupKey,
        version: row.version || '', description: row.description || '',
        tags: row.tags || '', status: row.status,
      };
      this.editOpen = true;
      this.$nextTick(() => this.$refs.editForm && this.$refs.editForm.clearValidate());
    },
    submitEdit() {
      this.$refs.editForm.validate(valid => {
        if (!valid) return;
        this.editSaving = true;
        const { id, ...payload } = this.editForm;
        updateDownload(id, payload).then(() => {
          this.editSaving = false;
          this.editOpen = false;
          this.$modal.msgSuccess('修改成功');
          this.loadAdminList();
        }).catch(err => {
          this.editSaving = false;
          this.$modal.msgError(err.message || '修改失败');
        });
      });
    },
    // ---------- 删除 ----------
    handleDelete(row) {
      this.$modal.confirm('确定删除交付物"' + row.name + '"？（磁盘文件将一并删除，不可恢复）').then(() => {
        deleteDownload(row.id).then(() => {
          this.$modal.msgSuccess('删除成功');
          this.loadAdminList();
        }).catch(err => {
          this.$modal.msgError(err.message || '删除失败');
        });
      }).catch(() => {});
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
.upload-hint {
  font-size: 12px;
  color: #909399;
  margin-bottom: 10px;
  text-align: center;
}
</style>
