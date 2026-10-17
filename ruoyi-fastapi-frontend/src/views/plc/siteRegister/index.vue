<template>
  <div class="app-container">
    <!-- 登记说明 -->
    <el-card shadow="never" class="tip-card">
      <div class="tip-title"><i class="el-icon-info" /> 采集点登记</div>
      <p class="tip-text">
        为<b>采集节点（Node-RED 采集 PC）</b>登记采集点信息，一次登记同时创建健康监控档案。
        提交后生成<b>健康监控密钥</b>（<b>仅显示一次</b>），现场在 site-health 节点录入即接入监控。
        密钥遗失请到「采集监控」页重置；生成采集流程请前往「流程发布」。
      </p>
    </el-card>

    <!-- 登记表单 -->
    <el-card shadow="never" class="form-card">
      <el-form ref="form" :model="form" :rules="rules" label-width="100px">
        <!-- 网络信息 -->
        <div class="form-section">
          <div class="section-caption"><i class="el-icon-link" /> 网络信息</div>
          <el-row :gutter="20">
            <el-col :span="8">
              <el-form-item label="办公网IP" prop="officeIp">
                <el-input v-model="form.officeIp" placeholder="如 10.81.1.100" maxlength="20" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="工业网IP" prop="industIp">
                <el-input v-model="form.industIp" placeholder="采集点工业网卡IP，如 192.168.1.10" maxlength="20" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="端口" prop="nodePort">
                <el-input v-model="form.nodePort" placeholder="Node-RED 监听端口，如 1880" maxlength="5" />
              </el-form-item>
            </el-col>
          </el-row>
        </div>

        <!-- 位置信息 -->
        <div class="form-section">
          <div class="section-caption"><i class="el-icon-location-outline" /> 位置信息</div>
          <el-row :gutter="20">
            <el-col :span="8">
              <el-form-item label="栋别" prop="building">
                <el-input v-model="form.building" placeholder="如 A栋" maxlength="50" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="楼层" prop="floor">
                <el-input v-model="form.floor" placeholder="如 3F" maxlength="50" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="工程" prop="processStage">
                <el-input v-model="form.processStage" placeholder="如 冲压工程" maxlength="50" />
              </el-form-item>
            </el-col>
          </el-row>
        </div>

        <!-- 其他信息 -->
        <div class="form-section">
          <div class="section-caption"><i class="el-icon-document" /> 其他信息</div>
          <el-row :gutter="20">
            <el-col :span="12">
              <el-form-item label="采集点名称" prop="nodeName">
                <el-input v-model="form.nodeName" placeholder="如 一号车间采集节点" maxlength="100" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="采集点标识" prop="nodeKey">
                <el-input v-model="form.nodeKey" placeholder="留空自动生成（pc-IP-端口）" maxlength="64" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-row :gutter="20">
            <el-col :span="24">
              <el-form-item label="Teams Webhook" prop="teamsWebhook">
                <el-input v-model="form.teamsWebhook" placeholder="断线通知用 Teams Incoming Webhook 地址（可空）" maxlength="500" />
              </el-form-item>
            </el-col>
          </el-row>
        </div>

        <div class="form-actions">
          <el-button type="primary" icon="el-icon-key" :loading="submitting" @click="handleSubmit">提交并生成密钥</el-button>
          <el-button icon="el-icon-refresh-left" @click="resetForm">重置</el-button>
        </div>
      </el-form>
    </el-card>

    <!-- 密钥一次性展示对话框 -->
    <el-dialog title="采集点登记成功" :visible.sync="keyOpen" width="560px" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="false" append-to-body>
      <el-alert
        title="请立即复制保存密钥，关闭后无法再次查看！"
        type="warning"
        :closable="false"
        show-icon
      />
      <div class="key-box">
        <div class="key-label">采集点标识</div>
        <div class="key-value id-value">{{ newNodeKey }}</div>
        <template v-if="newHealthKey">
          <div class="key-label">健康监控密钥（site-health 节点录入用）</div>
          <div class="key-value">{{ newHealthKey }}</div>
        </template>
        <div v-else-if="healthExisted" class="key-note">健康监控此前已登记，未重复创建；如需更换监控密钥请到「采集监控」页重置。</div>
        <div v-else class="key-note">健康监控密钥生成异常，请到「存量监控 → 采集登记」单独登记。</div>
      </div>
      <div class="key-actions">
        <el-button v-if="newHealthKey" type="primary" icon="el-icon-copy-document" @click="copyHealthKey">复制监控密钥</el-button>
        <el-button type="warning" plain @click="closeKeyDialog">我已保存，关闭</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script>
import { addBootstrapKey } from "@/api/plc/bootstrapKey";

export default {
  name: "SiteRegister",
  data() {
    return {
      submitting: false,
      keyOpen: false,
      newNodeKey: '',
      newKey: '',
      newHealthKey: '',    // 联动登记的健康监控密钥（一次性展示）
      healthExisted: false, // 健康监控已登记过（未重复创建）
      form: {
        officeIp: null,
        industIp: null,
        nodePort: null,
        building: null,
        floor: null,
        processStage: null,
        nodeName: null,
        nodeKey: null,
        teamsWebhook: null,
      },
      rules: {
        officeIp: [
          { required: true, message: "办公网IP不能为空", trigger: "blur" },
          { pattern: /^((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/, message: "IP地址格式不正确", trigger: "blur" }
        ],
        industIp: [
          { required: true, message: "工业网IP不能为空", trigger: "blur" },
          { pattern: /^((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/, message: "IP地址格式不正确", trigger: "blur" }
        ],
        nodePort: [
          { required: true, message: "端口不能为空", trigger: "blur" },
          {
            validator: (rule, value, callback) => {
              const n = Number(value);
              if (!Number.isInteger(n) || n < 1 || n > 65535) return callback(new Error('端口范围 1-65535'));
              callback();
            },
            trigger: "blur"
          }
        ],
        building: [
          { required: true, message: "栋别不能为空", trigger: "blur" }
        ],
        floor: [
          { required: true, message: "楼层不能为空", trigger: "blur" }
        ],
        processStage: [
          { required: true, message: "工程不能为空", trigger: "blur" }
        ],
        nodeName: [
          { required: true, message: "采集点名称不能为空", trigger: "blur" }
        ],
        nodeKey: [
          { pattern: /^[a-zA-Z0-9_-]*$/, message: "只能包含字母、数字、下划线、中划线", trigger: "blur" }
        ],
      },
    };
  },
  methods: {
    /** 从 IP:端口 派生 nodeKey（pc-<ip>-<port> 风格） */
    deriveNodeKey(hostPcIp) {
      return 'pc-' + String(hostPcIp).replace(/\./g, '').replace(':', '-');
    },
    handleSubmit() {
      this.$refs["form"].validate(valid => {
        if (!valid) return;
        this.submitting = true;
        const hostPcIp = this.form.officeIp.trim() + ':' + String(this.form.nodePort).trim();
        const payload = {
          nodeName: this.form.nodeName,
          nodeKey: (this.form.nodeKey && this.form.nodeKey.trim()) || this.deriveNodeKey(hostPcIp),
          hostPcIp: hostPcIp,
          industIp: this.form.industIp,
          building: this.form.building,
          floor: this.form.floor,
          processStage: this.form.processStage,
          enabled: 1,
        };
        addBootstrapKey(payload).then(response => {
          this.submitting = false;
          this.newNodeKey = payload.nodeKey;
          this.newKey = response.data ? response.data.secretKey : '';
          this.newHealthKey = (response.data && response.data.healthKey) || '';
          this.healthExisted = !!(response.data && response.data.healthExisted);
          this.keyOpen = true;
          this.resetForm();
        }).catch(err => {
          this.submitting = false;
          this.$modal.msgError(err.message || "登记失败");
        });
      });
    },
    resetForm() {
      this.form = { officeIp: null, industIp: null, nodePort: null, building: null, floor: null, processStage: null, nodeName: null, nodeKey: null };
      this.$refs["form"] && this.$refs["form"].clearValidate();
    },
    copyKey() {
      const text = this.newKey;
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          this.$modal.msgSuccess("密钥已复制");
        }).catch(() => this.fallbackCopy(text));
      } else {
        this.fallbackCopy(text);
      }
    },
    copyHealthKey() {
      const text = this.newHealthKey;
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          this.$modal.msgSuccess("监控密钥已复制");
        }).catch(() => this.fallbackCopy(text));
      } else {
        this.fallbackCopy(text);
      }
    },
    fallbackCopy(text) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        this.$modal.msgSuccess("密钥已复制");
      } catch (e) {
        this.$modal.msgError("复制失败，请手动选择复制");
      }
      document.body.removeChild(ta);
    },
    closeKeyDialog() {
      this.keyOpen = false;
      // 关闭后彻底抹除明文
      this.newKey = '';
      this.newNodeKey = '';
      this.newHealthKey = '';
      this.healthExisted = false;
    },
  }
};
</script>

<style scoped>
.tip-card {
  margin-bottom: 16px;
}
.tip-title {
  font-weight: bold;
  font-size: 15px;
  margin-bottom: 8px;
  color: #303133;
}
.tip-title i {
  color: #409eff;
  margin-right: 4px;
}
.tip-text {
  color: #606266;
  font-size: 13px;
  line-height: 1.7;
  margin: 0;
}
.form-card {
  max-width: 960px;
}
/* 表单分区：左竖线小节标题 + 宽松留白（与存量监控登记页同款） */
.form-section {
  margin-bottom: 8px;
}
.section-caption {
  font-size: 13px;
  font-weight: bold;
  color: #303133;
  border-left: 3px solid #409eff;
  padding-left: 8px;
  margin-bottom: 16px;
}
.section-caption i {
  color: #409eff;
  margin-right: 4px;
}
.form-section .el-form-item {
  margin-bottom: 16px;
}
.form-actions {
  padding-top: 6px;
  border-top: 1px solid #f2f6fc;
}
.key-box {
  margin: 16px 0;
  padding: 16px;
  background: #f5f7fa;
  border: 1px dashed #dcdfe6;
  border-radius: 4px;
}
.key-label {
  color: #909399;
  font-size: 12px;
  margin-bottom: 4px;
}
.key-note {
  margin-top: 10px;
  font-size: 12px;
  color: #e6a23c;
}
.key-value {
  font-family: Menlo, Consolas, monospace;
  font-size: 15px;
  color: #303133;
  word-break: break-all;
  margin-bottom: 12px;
  user-select: all;
}
.key-value.id-value {
  color: #409eff;
}
.key-actions {
  text-align: center;
}
</style>
