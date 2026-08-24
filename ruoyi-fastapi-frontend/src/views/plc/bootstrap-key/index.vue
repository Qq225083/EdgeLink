<template>
  <div class="app-container">
    <!-- 查询条件 -->
    <el-form :model="queryParams" ref="queryForm" size="small" :inline="true" v-show="showSearch" label-width="80px">
      <el-form-item label="节点标识" prop="nodeKey">
        <el-input v-model="queryParams.nodeKey" placeholder="模糊查询" clearable @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="节点名称" prop="nodeName">
        <el-input v-model="queryParams.nodeName" placeholder="模糊查询" clearable @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="状态" prop="enabled">
        <el-select v-model="queryParams.enabled" placeholder="全部" clearable>
          <el-option label="启用" :value="1" />
          <el-option label="停用" :value="0" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="el-icon-search" size="mini" @click="handleQuery">搜索</el-button>
        <el-button icon="el-icon-refresh" size="mini" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <!-- 操作按钮栏 -->
    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="primary" icon="el-icon-plus" size="mini" @click="handleAdd" v-hasPermi="['plc:bootstrap-key:add']">新增</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="success" icon="el-icon-edit" size="mini" :disabled="single" @click="handleUpdate" v-hasPermi="['plc:bootstrap-key:edit']">修改</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="danger" icon="el-icon-delete" size="mini" :disabled="multiple" @click="handleDelete" v-hasPermi="['plc:bootstrap-key:remove']">删除</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="warning" icon="el-icon-key" size="mini" @click="handleRegWindow" v-hasPermi="['plc:bootstrap-key:edit']">
          {{ regWindow.open ? '关闭注册(' + Math.ceil(regWindow.remainSeconds / 60) + '分钟)' : '开放注册' }}
        </el-button>
        <el-tag v-if="regWindow.open" type="warning" size="mini" style="margin-left:6px">新节点注册窗口开放中</el-tag>
      </el-col>
      <right-toolbar :showSearch.sync="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <!-- 节点列表表格 -->
    <el-table v-loading="loading" :data="keyList" @selection-change="handleSelectionChange">
      <el-table-column type="selection" width="55" align="center" />
      <el-table-column label="节点标识" align="center" prop="nodeKey" width="120" :show-overflow-tooltip="true" />
      <el-table-column label="节点名称" align="center" prop="nodeName" width="150" :show-overflow-tooltip="true" />
      <el-table-column label="节点地址" align="center" prop="hostPcIp" width="160" :show-overflow-tooltip="true" />
      <el-table-column label="密钥" align="center" prop="secretKey" width="180">
        <template slot-scope="scope">
          <span>{{ maskSecret(scope.row.secretKey) }}</span>
          <el-button type="text" size="mini" icon="el-icon-view" @click="showSecret(scope.row)" />
        </template>
      </el-table-column>
      <el-table-column label="状态" align="center" prop="enabled" width="80">
        <template slot-scope="scope">
          <el-switch v-model="scope.row.enabled" :active-value="1" :inactive-value="0" @change="handleStatusChange(scope.row)" />
        </template>
      </el-table-column>
      <el-table-column label="创建时间" align="center" prop="createdAt" width="160">
        <template slot-scope="scope">
          <span>{{ parseTime(scope.row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" align="center" class-name="small-padding fixed-width" width="200">
        <template slot-scope="scope">
          <el-button size="mini" type="text" icon="el-icon-edit" @click="handleUpdate(scope.row)" v-hasPermi="['plc:bootstrap-key:edit']">修改</el-button>
          <el-button size="mini" type="text" icon="el-icon-refresh" @click="handleRegenerate(scope.row)" v-hasPermi="['plc:bootstrap-key:edit']">重置密钥</el-button>
          <el-button size="mini" type="text" icon="el-icon-delete" style="color: #F56C6C" @click="handleDelete(scope.row)" v-hasPermi="['plc:bootstrap-key:remove']">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 分页 -->
    <pagination v-show="total>0" :total="total" :page.sync="queryParams.pageNum" :limit.sync="queryParams.pageSize" @pagination="getList" />

    <!-- 新增/编辑对话框 -->
    <el-dialog :title="title" :visible.sync="open" width="500px" append-to-body>
      <el-form ref="form" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="节点标识" prop="nodeKey">
          <el-input v-model="form.nodeKey" placeholder="如：pc-001" :disabled="form.id != null" />
        </el-form-item>
        <el-form-item label="节点名称" prop="nodeName">
          <el-input v-model="form.nodeName" placeholder="如：车间一采集节点" />
        </el-form-item>
        <el-form-item label="节点地址" prop="hostPcIp">
          <el-input v-model="form.hostPcIp" placeholder="如：192.168.1.3:1880（同一 IP:端口 只能绑定一个节点）" />
        </el-form-item>
        <el-form-item label="状态" prop="enabled">
          <el-radio-group v-model="form.enabled">
            <el-radio :label="1">启用</el-radio>
            <el-radio :label="0">停用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button type="primary" @click="submitForm">确 定</el-button>
          <el-button @click="cancel">取 消</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 密钥查看对话框 -->
    <el-dialog title="节点密钥" :visible.sync="secretOpen" width="400px" append-to-body>
      <div class="secret-display">
        <p><strong>节点标识：</strong>{{ currentKey.nodeKey }}</p>
        <p><strong>节点名称：</strong>{{ currentKey.nodeName || '--' }}</p>
        <p><strong>节点地址：</strong>{{ currentKey.hostPcIp || '--' }}</p>
        <p><strong>密钥：</strong></p>
        <el-input v-model="currentKey.secretKey" readonly>
          <el-button slot="append" icon="el-icon-copy-document" @click="copySecret" />
        </el-input>
        <p class="secret-tip">请妥善保管此密钥，泄露后请立即重置</p>
      </div>
      <template #footer>
        <el-button @click="secretOpen = false">关 闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script>
import { listBootstrapKey, addBootstrapKey, updateBootstrapKey, delBootstrapKey, toggleBootstrapKeyStatus, regenerateBootstrapKey, openRegistrationWindow, getRegistrationWindow, closeRegistrationWindow } from "@/api/plc/bootstrapKey";

export default {
  name: "BootstrapKey",
  data() {
    return {
      loading: true,
      ids: [],
      single: true,
      multiple: true,
      showSearch: true,
      total: 0,
      keyList: [],
      title: "",
      open: false,
      secretOpen: false,
      currentKey: {},
      queryParams: {
        pageNum: 1,
        pageSize: 10,
        nodeKey: null,
        nodeName: null,
        enabled: null,
      },
      form: {},
      regWindow: { open: false, remainSeconds: 0 },
      regWindowTimer: null,
      rules: {
        nodeKey: [
          { required: true, message: "节点标识不能为空", trigger: "blur" },
          { pattern: /^[a-zA-Z0-9_-]+$/, message: "只能包含字母、数字、下划线、中划线", trigger: "blur" }
        ],
        hostPcIp: [
          { pattern: /^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/, message: "请输入正确的IP地址格式（支持 IP:端口）", trigger: "blur" }
        ]
      }
    };
  },
  created() {
    this.getList();
    this.refreshRegWindow();
    // 窗口状态每 30s 刷新（页面销毁时清理）
    this.regWindowTimer = setInterval(this.refreshRegWindow, 30000);
  },
  beforeDestroy() {
    if (this.regWindowTimer) { clearInterval(this.regWindowTimer); this.regWindowTimer = null; }
  },
  methods: {
    /** 注册窗口：开放/关闭切换 */
    handleRegWindow() {
      if (this.regWindow.open) {
        closeRegistrationWindow().then(() => {
          this.$modal.msgSuccess('注册窗口已关闭');
          this.refreshRegWindow();
        }).catch(err => {
          this.$modal.msgError(err.msg || '操作失败');
        });
      } else {
        this.$modal.confirm('开放后 10 分钟内允许新节点自动注册接入，确认开放？').then(() => {
          return openRegistrationWindow(10);
        }).then(response => {
          this.$modal.msgSuccess(response.msg || '注册窗口已开放');
          this.refreshRegWindow();
        }).catch(() => {});
      }
    },
    /** 刷新注册窗口状态 */
    refreshRegWindow() {
      getRegistrationWindow().then(response => {
        this.regWindow = response.data || { open: false, remainSeconds: 0 };
      }).catch(() => {});
    },
    /** 查询列表 */
    getList() {
      this.loading = true;
      listBootstrapKey(this.queryParams).then(response => {
        this.keyList = response.rows || [];
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
    /** 选择变化 */
    handleSelectionChange(selection) {
      this.ids = selection.map(item => item.id);
      this.single = selection.length != 1;
      this.multiple = !selection.length;
    },
    /** 新增 */
    handleAdd() {
      this.form = {
        id: null,
        nodeKey: null,
        nodeName: null,
        hostPcIp: null,
        enabled: 1
      };
      this.title = "新增边缘节点";
      this.open = true;
    },
    /** 修改 */
    handleUpdate(row) {
      const id = row.id || this.ids[0];
      const item = this.keyList.find(k => k.id === id);
      if (item) {
        this.form = { ...item };
        this.title = "修改边缘节点";
        this.open = true;
      }
    },
    /** 提交 */
    submitForm() {
      this.$refs["form"].validate(valid => {
        if (valid) {
          if (this.form.id != null) {
            updateBootstrapKey(this.form).then(response => {
              this.$modal.msgSuccess("修改成功");
              this.open = false;
              this.getList();
            }).catch(err => {
              this.$modal.msgError(err.msg || "修改失败");
            });
          } else {
            addBootstrapKey(this.form).then(response => {
              // 🔧 密钥只在新增响应中返回一次：直接弹出密钥对话框供保存
              if (response.data && response.data.secretKey) {
                this.currentKey = {
                  nodeKey: this.form.nodeKey,
                  nodeName: this.form.nodeName,
                  hostPcIp: this.form.hostPcIp,
                  secretKey: response.data.secretKey
                };
                this.secretOpen = true;
              } else {
                this.$modal.msgSuccess(response.msg || "新增成功");
              }
              this.open = false;
              this.getList();
            }).catch(err => {
              this.$modal.msgError(err.msg || "新增失败");
            });
          }
        }
      });
    },
    /** 取消 */
    cancel() {
      this.open = false;
    },
    /** 状态切换 */
    handleStatusChange(row) {
      const newStatus = row.enabled;
      const oldStatus = newStatus === 1 ? 0 : 1;
      toggleBootstrapKeyStatus(row.id, newStatus).then(() => {
        this.$modal.msgSuccess(newStatus === 1 ? '已启用' : '已停用');
      }).catch(() => {
        row.enabled = oldStatus;
        this.$modal.msgError('状态切换失败');
      });
    },
    /** 重新生成密钥 */
    handleRegenerate(row) {
      this.$modal.confirm('确定要重置节点"' + row.nodeKey + '"的密钥吗？重置后该节点需要使用新密钥才能接入。').then(() => {
        return regenerateBootstrapKey(row.id);
      }).then(response => {
        // 🔧 新密钥只在重置响应中返回一次：直接弹出密钥对话框供保存
        if (response.data && response.data.secretKey) {
          this.currentKey = {
            nodeKey: row.nodeKey,
            nodeName: row.nodeName,
            hostPcIp: row.hostPcIp,
            secretKey: response.data.secretKey
          };
          this.secretOpen = true;
        } else {
          this.$modal.msgSuccess(response.msg || '密钥已重置');
        }
        this.getList();
      }).catch(() => {});
    },
    /** 删除 */
    handleDelete(row) {
      const ids = row.id || this.ids.join(',');
      this.$modal.confirm('是否确认删除编号为"' + ids + '"的节点？删除后该节点将无法接入。').then(() => {
        return delBootstrapKey(ids);
      }).then(() => {
        this.getList();
        this.$modal.msgSuccess("删除成功");
      }).catch(() => {});
    },
    /** 显示密钥 */
    showSecret(row) {
      // 🔧 密钥只存哈希，列表不再下发：历史密钥不可查看，引导用户重置
      if (row.secretKey) {
        this.currentKey = { ...row };
        this.secretOpen = true;
      } else {
        this.$modal.msgWarning('密钥仅在新增/重置时显示一次，无法再次查看；如需获取请使用"重置"功能');
      }
    },
    /** 复制密钥 */
    copySecret() {
      navigator.clipboard.writeText(this.currentKey.secretKey).then(() => {
        this.$modal.msgSuccess('密钥已复制到剪贴板');
      }).catch(() => {
        this.$modal.msgError('复制失败，请手动复制');
      });
    },
    /** 密钥脱敏显示 */
    maskSecret(secret) {
      if (!secret || secret.length < 8) return '****';
      return secret.substring(0, 4) + '****' + secret.substring(secret.length - 4);
    }
  }
};
</script>

<style scoped>
.secret-display p {
  margin: 8px 0;
}
.secret-tip {
  color: #E6A23C;
  font-size: 12px;
  margin-top: 10px;
}
</style>
