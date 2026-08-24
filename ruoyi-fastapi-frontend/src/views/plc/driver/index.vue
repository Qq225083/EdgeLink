<template>
  <div class="app-container">
    <!-- 查询条件 -->
    <el-form :model="queryParams" ref="queryForm" size="small" :inline="true" v-show="showSearch" label-width="80px">
      <el-form-item label="驱动编码" prop="driverCode">
        <el-input v-model="queryParams.driverCode" placeholder="模糊查询" clearable @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="驱动名称" prop="driverName">
        <el-input v-model="queryParams.driverName" placeholder="模糊查询" clearable @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="状态" prop="enabled">
        <el-select v-model="queryParams.enabled" placeholder="全部" clearable>
          <el-option label="启用" :value="true" />
          <el-option label="停用" :value="false" />
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
        <el-button type="primary" icon="el-icon-plus" size="mini" @click="handleAdd" v-hasPermi="['plc:driver-admin:add']">新增</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="success" icon="el-icon-edit" size="mini" :disabled="single" @click="handleUpdate" v-hasPermi="['plc:driver-admin:edit']">修改</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="danger" icon="el-icon-delete" size="mini" :disabled="multiple" @click="handleDelete" v-hasPermi="['plc:driver-admin:remove']">删除</el-button>
      </el-col>
      <right-toolbar :showSearch.sync="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <!-- 驱动列表表格 -->
    <el-table v-loading="loading" :data="driverList" @selection-change="handleSelectionChange">
      <el-table-column type="selection" width="55" align="center" />
      <el-table-column label="驱动编码" align="center" prop="driverCode" width="140" :show-overflow-tooltip="true" />
      <el-table-column label="驱动名称" align="center" prop="driverName" width="180" :show-overflow-tooltip="true" />
      <el-table-column label="Node-RED 节点类型" align="center" prop="nodeRedNodeType" width="160" :show-overflow-tooltip="true" />
      <el-table-column label="位偏移" align="center" prop="bitOffsetSupported" width="70">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.bitOffsetSupported" type="success" size="mini">支持</el-tag>
          <el-tag v-else type="info" size="mini">不支持</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="字节序" align="center" prop="byteOrderSupported" width="70">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.byteOrderSupported" type="success" size="mini">支持</el-tag>
          <el-tag v-else type="info" size="mini">不支持</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="字序" align="center" prop="wordOrderSupported" width="70">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.wordOrderSupported" type="success" size="mini">支持</el-tag>
          <el-tag v-else type="info" size="mini">不支持</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" align="center" prop="enabled" width="80">
        <template slot-scope="scope">
          <el-switch v-model="scope.row.enabled" @change="handleStatusChange(scope.row)" />
        </template>
      </el-table-column>
      <el-table-column label="排序" align="center" prop="sortOrder" width="60" />
      <el-table-column label="操作" align="center" class-name="small-padding fixed-width" width="200">
        <template slot-scope="scope">
          <el-button size="mini" type="text" icon="el-icon-edit" @click="handleUpdate(scope.row)" v-hasPermi="['plc:driver-admin:edit']">修改</el-button>
          <el-button size="mini" type="text" icon="el-icon-delete" style="color: #F56C6C" @click="handleDelete(scope.row)" v-hasPermi="['plc:driver-admin:remove']">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 分页 -->
    <pagination v-show="total>0" :total="total" :page.sync="queryParams.pageNum" :limit.sync="queryParams.pageSize" @pagination="getList" />

    <!-- 新增/编辑对话框 -->
    <el-dialog :title="title" :visible.sync="open" width="90%" :class="'dialog-lg'" append-to-body>
      <el-form ref="form" :model="form" :rules="rules" label-width="120px">
        <el-tabs v-model="activeTab">
          <el-tab-pane label="基本信息" name="basic">
            <el-row>
              <el-col :span="12">
                <el-form-item label="驱动编码" prop="driverCode">
                  <el-input v-model="form.driverCode" placeholder="如：siemens_s7" :disabled="form.id != null" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="驱动名称" prop="driverName">
                  <el-input v-model="form.driverName" placeholder="如：西门子 S7 协议" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-row>
              <el-col :span="12">
                <el-form-item label="Node-RED 节点类型" prop="nodeRedNodeType">
                  <el-input v-model="form.nodeRedNodeType" placeholder="如：siemens-s7-read" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="地址校验正则" prop="addressPattern">
                  <el-input v-model="form.addressPattern" placeholder="如：^[0-9]+(\.[0-9]+)?$" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-row>
              <el-col :span="8">
                <el-form-item label="位偏移" prop="bitOffsetSupported">
                  <el-switch v-model="form.bitOffsetSupported" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="字节序" prop="byteOrderSupported">
                  <el-switch v-model="form.byteOrderSupported" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="字序" prop="wordOrderSupported">
                  <el-switch v-model="form.wordOrderSupported" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-row>
              <el-col :span="8">
                <el-form-item label="状态" prop="enabled">
                  <el-switch v-model="form.enabled" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="schema 版本" prop="schemaVersion">
                  <el-input-number v-model="form.schemaVersion" :min="1" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="排序" prop="sortOrder">
                  <el-input-number v-model="form.sortOrder" :min="0" style="width: 100%" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="备注" prop="remark">
              <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="请输入备注" />
            </el-form-item>
          </el-tab-pane>

          <el-tab-pane label="协议参数 Schema" name="schema">
            <el-form-item label="config_schema" prop="configSchema">
              <el-input v-model="configSchemaText" type="textarea" :rows="15" placeholder='{"fields":[{"name":"unitId","type":"number","label":"Unit ID","default":1,"min":1,"max":247,"required":true}]}' />
            </el-form-item>
          </el-tab-pane>

          <el-tab-pane label="寄存器类型" name="registers">
            <el-form-item label="register_types" prop="registerTypes">
              <el-input v-model="registerTypesText" type="textarea" :rows="15" placeholder='[{"value":"DB","label":"DB（数据块）","dataTypes":["INT16","UINT16","INT32","UINT32","FLOAT","DOUBLE"]}]' />
            </el-form-item>
          </el-tab-pane>

          <el-tab-pane label="数据类型" name="dataTypes">
            <el-form-item label="data_types" prop="dataTypes">
              <el-input v-model="dataTypesText" type="textarea" :rows="15" placeholder='[{"value":"BIT","label":"BIT","bitOffsetSupport":true,"byteOrderSupport":false,"wordOrderSupport":false}]' />
            </el-form-item>
          </el-tab-pane>
        </el-tabs>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button type="primary" @click="submitForm">确 定</el-button>
          <el-button @click="cancel">取 消</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script>
import { listDriverAdmin, addDriverAdmin, updateDriverAdmin, delDriverAdmin, toggleDriverAdminStatus } from "@/api/plc/driverAdmin";

export default {
  name: "PlcDriverAdmin",
  data() {
    return {
      loading: true,
      ids: [],
      single: true,
      multiple: true,
      showSearch: true,
      total: 0,
      driverList: [],
      title: "",
      open: false,
      activeTab: 'basic',
      queryParams: {
        pageNum: 1,
        pageSize: 10,
        driverCode: null,
        driverName: null,
        enabled: null,
      },
      form: {},
      configSchemaText: '',
      registerTypesText: '',
      dataTypesText: '',
      rules: {
        driverCode: [
          { required: true, message: "驱动编码不能为空", trigger: "blur" },
          { pattern: /^[a-zA-Z0-9_]+$/, message: "只能包含字母、数字、下划线", trigger: "blur" }
        ],
        driverName: [
          { required: true, message: "驱动名称不能为空", trigger: "blur" }
        ],
        nodeRedNodeType: [
          { required: true, message: "Node-RED 节点类型不能为空", trigger: "blur" }
        ]
      }
    };
  },
  created() {
    this.getList();
  },
  methods: {
    /** 查询列表 */
    getList() {
      this.loading = true;
      listDriverAdmin(this.queryParams).then(response => {
        this.driverList = response.rows || [];
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
        driverCode: null,
        driverName: null,
        nodeRedNodeType: null,
        configSchema: { fields: [] },
        registerTypes: [],
        dataTypes: [],
        addressPattern: null,
        bitOffsetSupported: false,
        byteOrderSupported: false,
        wordOrderSupported: false,
        enabled: true,
        schemaVersion: 1,
        sortOrder: 0,
        remark: null
      };
      this.configSchemaText = JSON.stringify(this.form.configSchema, null, 2);
      this.registerTypesText = JSON.stringify(this.form.registerTypes, null, 2);
      this.dataTypesText = JSON.stringify(this.form.dataTypes, null, 2);
      this.title = "新增驱动";
      this.open = true;
      this.activeTab = 'basic';
    },
    /** 修改 */
    handleUpdate(row) {
      const id = row.id || this.ids[0];
      const item = this.driverList.find(d => d.id === id);
      if (item) {
        this.form = { ...item };
        this.configSchemaText = JSON.stringify(item.configSchema, null, 2);
        this.registerTypesText = JSON.stringify(item.registerTypes, null, 2);
        this.dataTypesText = JSON.stringify(item.dataTypes, null, 2);
        this.title = "修改驱动";
        this.open = true;
        this.activeTab = 'basic';
      }
    },
    /** 提交 */
    submitForm() {
      this.$refs["form"].validate(valid => {
        if (valid) {
          // 解析 JSON 文本
          try {
            this.form.configSchema = JSON.parse(this.configSchemaText);
            this.form.registerTypes = JSON.parse(this.registerTypesText);
            this.form.dataTypes = JSON.parse(this.dataTypesText);
          } catch (e) {
            this.$modal.msgError('JSON 格式错误：' + e.message);
            return;
          }

          if (this.form.id != null) {
            updateDriverAdmin(this.form).then(response => {
              this.$modal.msgSuccess("修改成功");
              this.open = false;
              this.getList();
            }).catch(err => {
              this.$modal.msgError(err.msg || "修改失败");
            });
          } else {
            addDriverAdmin(this.form).then(response => {
              this.$modal.msgSuccess("新增成功");
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
      const oldStatus = !newStatus;
      toggleDriverAdminStatus(row.id, newStatus).then(() => {
        this.$modal.msgSuccess(newStatus ? '已启用' : '已停用');
      }).catch(() => {
        row.enabled = oldStatus;
        this.$modal.msgError('状态切换失败');
      });
    },
    /** 删除 */
    handleDelete(row) {
      const ids = row.id || this.ids.join(',');
      this.$modal.confirm('是否确认删除编号为"' + ids + '"的驱动？删除前请确认没有设备正在使用。').then(() => {
        return delDriverAdmin(ids);
      }).then(() => {
        this.getList();
        this.$modal.msgSuccess("删除成功");
      }).catch(() => {});
    }
  }
};
</script>

<style scoped>
/* 对话框宽度限制 */
::v-deep .dialog-lg .el-dialog { max-width: 1000px; }
</style>
