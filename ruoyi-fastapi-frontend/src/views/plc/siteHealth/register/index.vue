<template>
  <div class="app-container">
    <!-- 登记说明 -->
    <el-card shadow="never" class="tip-card">
      <div class="tip-title"><i class="el-icon-info" /> 情报登录</div>
      <p class="tip-text">
        为<b>旧版 Node-RED 采集程序</b>登记一个采集点。填写以下情报信息并提交后，系统会生成一个<b>唯一密钥（Key）</b>，
        该密钥<b>仅显示一次</b>，关闭后无法再次查看；如需更换请到「采集点监控」页重置密钥。
      </p>
    </el-card>

    <!-- 登记表单 -->
    <el-card shadow="never" class="form-card">
      <el-form ref="form" :model="form" :rules="rules" label-width="90px">
        <!-- 网络信息 -->
        <div class="form-section">
          <div class="section-caption"><i class="el-icon-link" /> 网络信息</div>
          <el-row :gutter="20">
            <el-col :span="12">
              <el-form-item label="办公网IP" prop="officeIp">
                <el-input v-model="form.officeIp" placeholder="如 10.81.8.34" maxlength="20" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="工业网IP" prop="industIp">
                <el-input v-model="form.industIp" placeholder="选填，如 192.168.1.10" maxlength="20" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-row :gutter="20">
            <el-col :span="12">
              <el-form-item label="端口" prop="nodePort">
                <el-input v-model="form.nodePort" placeholder="Node-RED 监听端口，如 1880" maxlength="5" />
              </el-form-item>
            </el-col>
          </el-row>
        </div>

        <!-- 位置信息（采集场所拆分，全部必填，支撑精确统计） -->
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
              <el-form-item label="采集场所" prop="siteName">
                <el-input v-model="form.siteName" placeholder="如 一号车间东侧" maxlength="100" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="联系人" prop="contact">
                <el-input v-model="form.contact" placeholder="选填，如 张三" maxlength="50" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item label="采集备注" prop="remark">
            <el-input v-model="form.remark" type="textarea" :rows="3" placeholder="选填，如采集点位范围、程序版本等" maxlength="200" show-word-limit />
          </el-form-item>
        </div>

        <div class="form-actions">
          <el-button type="primary" icon="el-icon-key" :loading="submitting" @click="handleSubmit">提交并生成密钥</el-button>
          <el-button icon="el-icon-refresh-left" @click="resetForm">重置</el-button>
        </div>
      </el-form>
    </el-card>

    <!-- 采集节点部署卡片：一键下载存量监控节点包 -->
    <el-card shadow="never" class="deploy-card">
      <div slot="header" class="deploy-header">
        <i class="el-icon-download" /> 采集节点部署
      </div>
      <div class="deploy-body">
        <div class="deploy-info">
          <div class="deploy-title">存量监控节点包</div>
          <div class="deploy-desc">下载后解压到 Node-RED 的 node_modules 目录下，重启 Node-RED 即可自动识别并加载。</div>
          <div class="deploy-meta">版本：v1.0.6 | 格式：zip | 适用：Node-RED 3.x/4.x</div>
        </div>
        <div class="deploy-action">
          <el-button type="primary" icon="el-icon-download" :loading="downloading" @click="downloadNodePackage">下载节点包</el-button>
        </div>
      </div>
      <el-divider />
      <div class="deploy-steps">
        <div class="steps-title">安装步骤：</div>
        <ol>
          <li>点击上方按钮下载 node-red-contrib-edgelink-site-health.zip</li>
          <li>解压 zip 文件，得到 node-red-contrib-edgelink-site-health 文件夹</li>
          <li>将文件夹复制到 Node-RED 的 node_modules 目录下</li>
          <li>重启 Node-RED 服务（node-red-restart 或手动重启）</li>
          <li>在 Node-RED 编辑器左侧节点栏中即可看到"存量监控"节点</li>
        </ol>
      </div>
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
        <div class="key-label">采集点 ID</div>
        <div class="key-value id-value">{{ newSiteId }}</div>
        <div class="key-label">密钥 Key</div>
        <div class="key-value">{{ newKey }}</div>
      </div>
      <div class="key-actions">
        <el-button type="primary" icon="el-icon-copy-document" :disabled="!newKey" @click="copyKey">复制密钥</el-button>
        <el-button type="warning" plain @click="closeKeyDialog">我已保存，关闭</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script>
import { addSite } from "@/api/plc/siteHealth";

export default {
  name: "SiteHealthRegister",
  data() {
    return {
      submitting: false,
      downloading: false,   // 节点包下载中状态（按钮 loading）
      keyOpen: false,
      newSiteId: null,
      newKey: '',
      form: {
        officeIp: null,
        industIp: null,
        siteName: null,
        building: null,
        floor: null,
        processStage: null,
        contact: null,
        remark: null,
        nodePort: null,
      },
      rules: {
        officeIp: [
          { required: true, message: "办公网IP不能为空", trigger: "blur" },
          { pattern: /^((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/, message: "IP地址格式不正确", trigger: "blur" }
        ],
        industIp: [
          { pattern: /^((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/, message: "IP地址格式不正确", trigger: "blur" }
        ],
        siteName: [
          { required: true, message: "采集场所不能为空", trigger: "blur" }
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
      },
    };
  },
  methods: {
    handleSubmit() {
      this.$refs["form"].validate(valid => {
        if (!valid) return;
        this.submitting = true;
        const payload = { ...this.form, nodePort: this.form.nodePort === '' || this.form.nodePort == null ? null : Number(this.form.nodePort) };
        addSite(payload).then(response => {
          this.submitting = false;
          this.newSiteId = response.data ? response.data.siteId : null;
          this.newKey = response.data ? response.data.key : '';
          this.keyOpen = true;
          this.resetForm();
        }).catch(err => {
          this.submitting = false;
          this.$modal.msgError(err.message || "登记失败");
        });
      });
    },
    resetForm() {
      this.form = {
        officeIp: null,
        industIp: null,
        siteName: null,
        building: null,
        floor: null,
        processStage: null,
        contact: null,
        remark: null,
        nodePort: null,
      };
      this.$refs["form"] && this.$refs["form"].clearValidate();
    },
    copyKey() {
      const text = this.newKey;
      if (!text) return;
      // 优先使用剪贴板 API，失败回退到 execCommand
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          this.$modal.msgSuccess("密钥已复制");
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
      // 关闭后彻底抹除明文，避免留在内存里被再次读取
      this.newKey = '';
      this.newSiteId = null;
    },
    /** 下载存量监控节点包（走 axios+blob 携带 JWT，避免裸 <a> 无鉴权头被 PreAuth 拦截） */
    downloadNodePackage() {
      this.downloading = true;
      this.$download.zip('/common/download/site-health-node', 'node-red-contrib-edgelink-site-health.zip');
      setTimeout(() => {
        this.downloading = false;
        this.$message.success('下载已开始，请检查浏览器下载栏');
      }, 1000);
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
/* 表单分区：左竖线小节标题 + 宽松留白，替代灰底框 */
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
/* ===== 采集节点部署卡片 ===== */
.deploy-card {
  max-width: 960px;
  margin-top: 16px;
}
.deploy-header {
  font-weight: bold;
  color: #303133;
}
.deploy-header i {
  color: #409eff;
  margin-right: 6px;
}
.deploy-body {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.deploy-title {
  font-size: 15px;
  font-weight: bold;
  color: #303133;
}
.deploy-desc {
  margin-top: 6px;
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
}
.deploy-meta {
  margin-top: 6px;
  font-size: 12px;
  color: #909399;
}
.deploy-action {
  flex-shrink: 0;
}
.deploy-steps .steps-title {
  font-size: 13px;
  font-weight: bold;
  color: #303133;
  margin-bottom: 6px;
}
.deploy-steps ol {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  color: #606266;
  line-height: 1.9;
}
</style>
