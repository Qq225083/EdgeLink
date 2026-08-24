<template>
  <div class="app-container">
    <!-- 查询条件 -->
    <el-form :model="queryParams" ref="queryForm" size="small" :inline="true" v-show="showSearch" label-width="80px">
      <el-form-item label="设备名称" prop="deviceName">
        <el-input v-model="queryParams.deviceName" placeholder="请输入设备名称（模糊）" clearable @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="设备编号" prop="deviceCode">
        <el-input v-model="queryParams.deviceCode" placeholder="请输入设备编号" clearable @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="IP地址" prop="plcIp">
        <el-input v-model="queryParams.plcIp" placeholder="请输入IP地址（精确）" clearable @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item label="状态" prop="status">
        <el-select v-model="queryParams.status" placeholder="请选择状态" clearable>
          <el-option label="启用" value="0" />
          <el-option label="停用" value="1" />
        </el-select>
      </el-form-item>
      <el-form-item label="品牌" prop="plcBrand">
        <el-select v-model="queryParams.plcBrand" placeholder="请选择品牌" clearable>
          <el-option v-for="b in brandList" :key="b.value" :label="b.label" :value="b.value" />
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
        <el-button type="primary" icon="el-icon-plus" size="mini" @click="handleAdd" v-hasPermi="['plc:device:add']">新增</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="success" icon="el-icon-edit" size="mini" :disabled="single" @click="handleUpdate" v-hasPermi="['plc:device:edit']">修改</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="warning" icon="el-icon-switch-button" size="mini" :disabled="multiple" @click="handleDisable" v-hasPermi="['plc:device:remove']">停用</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="danger" icon="el-icon-delete" size="mini" :disabled="multiple" @click="handleDelete" v-hasPermi="['plc:device:remove']">删除</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="warning" icon="el-icon-download" size="mini" @click="handleExport" v-hasPermi="['plc:device:list']">导出</el-button>
      </el-col>
      <right-toolbar :showSearch.sync="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <!-- 设备列表表格 -->
    <el-table v-loading="loading" :data="deviceList" @selection-change="handleSelectionChange">
      <el-table-column type="selection" width="55" align="center" />
      <el-table-column label="设备编号" align="center" prop="deviceCode" width="110" :show-overflow-tooltip="true" />
      <el-table-column label="设备名称" align="center" prop="deviceName" width="140" :show-overflow-tooltip="true" />
      <el-table-column label="品牌" align="center" prop="plcBrand" width="90" />
      <el-table-column label="系列" align="center" prop="plcSeries" width="70" />
      <el-table-column label="PLC IP:端口" align="center" width="140">
        <template slot-scope="scope">
          <span>{{ scope.row.plcIp }}:{{ scope.row.plcPort }}</span>
        </template>
      </el-table-column>
      <el-table-column label="采集节点" align="center" prop="hostPcIp" width="140" :show-overflow-tooltip="true" />
      <el-table-column label="通信方式" align="center" prop="comType" width="110" />
      <el-table-column label="帧格式" align="center" prop="mcFrame" width="65" />
      <el-table-column label="采集周期" align="center" width="85">
        <template slot-scope="scope">
          <span>{{ scope.row.scanIntervalMs }}ms</span>
        </template>
      </el-table-column>
      <el-table-column label="超时/重试" align="center" width="100">
        <template slot-scope="scope">
          <span>{{ scope.row.commTimeoutMs }}ms / {{ scope.row.retryCount }}次</span>
        </template>
      </el-table-column>
      <el-table-column label="点位" align="center" prop="tagCount" width="55" />
      <el-table-column label="备注" align="center" prop="remark" width="55" :show-overflow-tooltip="true" />
      <el-table-column label="状态" align="center" prop="status" width="65">
        <template slot-scope="scope">
          <el-switch v-model="scope.row.status" active-value="0" inactive-value="1" @change="handleDeviceStatusChange(scope.row)" />
        </template>
      </el-table-column>
      <el-table-column label="操作" align="center" class-name="small-padding fixed-width" width="280">
        <template slot-scope="scope">
          <el-button size="mini" type="text" icon="el-icon-edit" @click="handleUpdate(scope.row)" v-hasPermi="['plc:device:edit']">修改</el-button>
          <el-button size="mini" type="text" icon="el-icon-switch-button" @click="handleDisable(scope.row)" v-hasPermi="['plc:device:remove']">停用</el-button>
          <el-button size="mini" type="text" icon="el-icon-delete" style="color: #F56C6C" @click="handleDelete(scope.row)" v-hasPermi="['plc:device:remove']">删除</el-button>
          <el-button size="mini" type="text" icon="el-icon-copy-document" @click="handleClone(scope.row)" v-hasPermi="['plc:device:add']">克隆</el-button>
          <el-button size="mini" type="text" icon="el-icon-s-operation" @click="handleManageTag(scope.row)" v-hasPermi="['plc:tag:list']">点位</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 分页 -->
    <pagination v-show="total>0" :total="total" :page.sync="queryParams.pageNum" :limit.sync="queryParams.pageSize" @pagination="getList" />

    <!-- 新增/编辑设备对话框 -->
    <el-dialog :title="title" :visible.sync="open" width="90%" :class="'dialog-md'" append-to-body>
      <el-form ref="form" :model="form" :rules="rules" label-width="110px">
        <el-tabs v-model="activeTab">
          <el-tab-pane label="基本属性" name="basic">
        <el-row>
          <el-col :span="12">
            <el-form-item label="设备名称" prop="deviceName">
              <el-input v-model="form.deviceName" placeholder="请输入设备名称" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="设备编号" prop="deviceCode">
              <el-input v-model="form.deviceCode" placeholder="如：PLC-Q-01" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row>
          <el-col :span="12">
            <el-form-item label="PLC品牌" prop="plcBrand">
              <el-select v-model="form.plcBrand" placeholder="请选择品牌" style="width: 100%" @change="onBrandChange">
                <el-option v-for="b in brandList" :key="b.value" :label="b.label" :value="b.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="PLC系列" prop="plcSeries">
              <el-select v-model="form.plcSeries" placeholder="请选择系列" style="width: 100%" @change="onSeriesChange" :disabled="!form.plcBrand">
                <el-option v-for="s in availableSeries" :key="s.value" :label="s.label" :value="s.value" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row>
          <el-col :span="12">
            <el-form-item label="通信方式" prop="comType">
              <el-select v-model="form.comType" placeholder="请选择通信方式" style="width: 100%" @change="onComTypeChange" :disabled="!form.plcSeries">
                <el-option v-for="c in availableComTypes" :key="c.value" :label="c.label" :value="c.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="驱动编码" prop="driverCode">
              <el-input v-model="form.driverCode" placeholder="自动识别" disabled style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
          </el-tab-pane>
          <el-tab-pane label="网络配置" name="network">
        <!-- PLC IP/端口：RS-232C 隐藏，其余显示 -->
        <el-row v-show="form.comType !== 'PLC_RS232C'">
          <el-col :span="12">
            <el-form-item label="PLC IP" prop="plcIp">
              <el-input v-model="form.plcIp" placeholder="如：192.168.1.100" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="PLC端口" prop="plcPort">
              <el-input-number v-model="form.plcPort" :min="1" :max="65535" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <!-- 办公网IP：确定由哪台电脑采集（必填，与 Node-RED 所在 PC 的办公网卡 IP 一致） -->
        <el-row>
          <el-col :span="12">
            <el-form-item label="采集节点 *" prop="hostPcIp">
              <el-input v-model="form.hostPcIp" placeholder="如：10.81.1.100 或 10.81.1.100:1881（多实例时用端口区分）" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="备办公网IP" prop="backupPcIp">
              <el-input v-model="form.backupPcIp" placeholder="可选，主办公网IP对应PC宕机时切换" />
            </el-form-item>
          </el-col>
        </el-row>
        <!-- 工业内网IP/端口：始终显示（选填，与PLC同网段的工业网络IP） -->
        <el-row>
          <el-col :span="12">
            <el-form-item label="工业内网IP *" prop="mesIp">
              <el-input v-model="form.mesIp" placeholder="如：192.168.0.100（必填，PLC同网段的工业网络IP）" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="工业内网端口" prop="mesPort">
              <el-input-number v-model="form.mesPort" :min="0" :max="65535" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <!-- 协议参数：按驱动 schema 动态渲染 -->
        <el-row v-if="driverSchemaFields.length > 0">
          <el-col :span="24">
            <el-divider content-position="left">协议参数（由驱动 {{ form.driverCode || 'UNKNOWN' }} 决定）</el-divider>
          </el-col>
          <el-col v-for="field in driverSchemaFields" :key="field.name" :span="field.type === 'textarea' ? 24 : 8">
            <el-form-item :label="field.label" :prop="field.name" :label-width="field.labelWidth || '100px'">
              <!-- select -->
              <el-select v-if="field.type === 'select'" v-model="form[field.name]" :placeholder="'请选择' + field.label" style="width: 100%">
                <el-option v-for="opt in field.options" :key="opt" :label="opt" :value="opt" />
              </el-select>
              <!-- number -->
              <el-input-number v-else-if="field.type === 'number'" v-model="form[field.name]" :min="field.min" :max="field.max" :step="field.step || 1" style="width: 100%" />
              <!-- textarea -->
              <el-input v-else-if="field.type === 'textarea'" v-model="form[field.name]" type="textarea" :rows="2" :placeholder="'请输入' + field.label" />
              <!-- text / 默认 -->
              <el-input v-else v-model="form[field.name]" :placeholder="'请输入' + field.label" />
            </el-form-item>
          </el-col>
        </el-row>

        <!-- 触发方式：公共字段 -->
        <el-row>
          <el-col :span="8">
            <el-form-item label="触发方式" prop="triggerKind" label-width="100px">
              <el-select v-model="form.triggerKind" placeholder="选择" style="width: 100%">
                <el-option label="固定周期" :value="1" />
                <el-option label="握手触发（规划中）" :value="0" disabled />
                <el-option label="变化触发（有变化才上报）" :value="2" />
              </el-select>
              <span style="font-size:11px;color:#999">固定周期=每周期都上报；变化触发=值不变则不插入/不推送。握手触发规划中</span>
            </el-form-item>
          </el-col>
        </el-row>
          </el-tab-pane>
          <el-tab-pane label="采集参数" name="collect">
        <el-row>
          <el-col :span="8">
            <el-form-item label="采集周期" prop="scanIntervalMs" label-width="70px">
              <el-input-number v-model="form.scanIntervalMs" :min="1000" :max="60000" :step="100" style="width: 100%" />
              <span style="font-size:11px;color:#999">当前最低 1000ms（1秒），亚秒级采集规划中</span>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="通信超时" prop="commTimeoutMs" label-width="70px">
              <el-input-number v-model="form.commTimeoutMs" :min="100" :max="30000" :step="100" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="重试次数" prop="retryCount" label-width="70px">
              <el-input-number v-model="form.retryCount" :min="0" :max="10" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row>
          <el-col :span="8">
            <el-form-item label="重试间隔" prop="retryIntervalMs" label-width="70px">
              <el-input-number v-model="form.retryIntervalMs" :min="100" :max="10000" :step="100" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="状态" prop="status" label-width="70px">
              <el-radio-group v-model="form.status">
                <el-radio label="0">启用</el-radio>
                <el-radio label="1">停用</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row>
          <el-col :span="24">
            <el-form-item label="备注" prop="remark">
              <el-input v-model="form.remark" type="textarea" placeholder="请输入备注" :rows="2" />
            </el-form-item>
          </el-col>
        </el-row>
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

    <!-- 克隆设备对话框 -->
    <el-dialog title="克隆PLC设备" :visible.sync="cloneOpen" width="90%" :class="'dialog-sm'" append-to-body>
      <el-form ref="cloneForm" :model="cloneForm" :rules="cloneRules" label-width="100px">
        <el-form-item label="源设备" prop="sourceName">
          <el-input v-model="cloneForm.sourceName" disabled />
        </el-form-item>
        <el-form-item label="新设备名称" prop="deviceName">
          <el-input v-model="cloneForm.deviceName" placeholder="请输入新设备名称" />
        </el-form-item>
        <el-form-item label="新设备编号" prop="deviceCode">
          <el-input v-model="cloneForm.deviceCode" placeholder="如：PLC-Q-02" />
        </el-form-item>
        <el-form-item label="新PLC IP" prop="plcIp">
          <el-input v-model="cloneForm.plcIp" placeholder="如：192.168.1.101" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button type="primary" @click="submitClone">确 定</el-button>
          <el-button @click="cloneOpen = false">取 消</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 导入结果对话框 -->
    <el-dialog title="导入结果" :visible.sync="importResultOpen" width="90%" :class="'dialog-sm'" append-to-body>
      <el-alert :title="'成功 ' + importResult.successCount + ' 条，失败 ' + importResult.failCount + ' 条'" :type="importResult.failCount > 0 ? 'warning' : 'success'" :closable="false" style="margin-bottom: 15px" />
      <el-table v-if="importResult.errors && importResult.errors.length" :data="importResult.errors" max-height="300" size="small">
        <el-table-column label="行号" prop="row" width="60" align="center" />
        <el-table-column label="失败原因" prop="reason" :show-overflow-tooltip="true" />
      </el-table>
    </el-dialog>

    <!-- 点位管理对话框 -->
    <el-dialog :title="tagDialogTitle" :visible.sync="tagOpen" width="95%" :class="'dialog-lg'" append-to-body @close="tagDialogClose">
      <el-row :gutter="10" class="mb8 toolbar-row">
        <el-col :xs="12" :sm="4" :md="2">
          <el-button type="primary" icon="el-icon-plus" size="mini" @click="handleAddTag" v-hasPermi="['plc:tag:add']">新增点位</el-button>
        </el-col>
        <el-col :xs="12" :sm="4" :md="2">
          <el-button type="warning" icon="el-icon-switch-button" size="mini" :disabled="tagMultiple" @click="handleDisableTag" v-hasPermi="['plc:tag:remove']">停用点位</el-button>
        </el-col>
        <el-col :xs="12" :sm="4" :md="2">
          <el-button type="danger" icon="el-icon-delete" size="mini" :disabled="tagMultiple" @click="handleDeleteTag" v-hasPermi="['plc:tag:remove']">删除点位</el-button>
        </el-col>
        <el-col :xs="12" :sm="4" :md="2">
          <el-button type="info" icon="el-icon-download" size="mini" @click="handleDownloadTemplate" v-hasPermi="['plc:tag:add']">下载模板</el-button>
        </el-col>
        <el-col :xs="12" :sm="4" :md="2">
          <el-upload
            :show-file-list="false"
            :before-upload="handleBeforeUpload"
            accept=".xlsx,.xls,.json"
            action=""
            v-hasPermi="['plc:tag:add']"
          >
            <el-button type="success" icon="el-icon-upload2" size="mini">导入点位</el-button>
          </el-upload>
        </el-col>
      </el-row>

      <!-- 设备信息摘要条 -->
      <el-alert :title="'设备: ' + currentDevice.deviceName + ' | 采集节点: ' + (currentDevice.hostPcIp || '-') + ' | PLC: ' + (currentDevice.plcIp || '-') + ':' + (currentDevice.plcPort || '-') + ' | 帧: ' + (currentDevice.mcFrame || '-') + ' | 站号: ' + (currentDevice.stationNo != null ? currentDevice.stationNo : '-') + ' | 网络号: ' + (currentDevice.networkNo != null ? currentDevice.networkNo : '-') + ' | 采集周期: ' + (currentDevice.scanIntervalMs || '-') + 'ms'" type="info" :closable="false" show-icon style="margin-bottom: 10px" />

      <el-table v-loading="tagLoading" :data="tagList" @selection-change="handleTagSelectionChange">
        <el-table-column type="selection" width="55" align="center" />
        <el-table-column label="点位名称" align="center" prop="tagName" :show-overflow-tooltip="true" width="130" />
        <el-table-column label="寄存器类型" align="center" prop="registerType" width="90">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.registerType === 'CALC'" type="warning" size="small">计算·{{ scope.row.calcOp }}</el-tag>
          <span v-else>{{ scope.row.registerType }}</span>
        </template>
      </el-table-column>
        <el-table-column label="地址" align="center" prop="registerAddress" width="100" />
        <el-table-column label="数据类型" align="center" prop="dataType" width="85" />
        <el-table-column label="单位" align="center" prop="unit" width="65" />
        <el-table-column label="描述" align="center" prop="description" :show-overflow-tooltip="true" width="150" />
        <el-table-column label="状态" align="center" prop="status" width="65">
          <template slot-scope="scope">
            <el-switch v-model="scope.row.status" active-value="0" inactive-value="1" @change="handleTagStatusChange(scope.row)" />
          </template>
        </el-table-column>
        <el-table-column label="排序" align="center" prop="sortOrder" width="55" />
        <el-table-column label="操作" align="center" class-name="small-padding fixed-width" width="130">
          <template slot-scope="scope">
            <el-button size="mini" type="text" icon="el-icon-edit" @click="handleUpdateTag(scope.row)" v-hasPermi="['plc:tag:edit']">修改</el-button>
            <el-button size="mini" type="text" icon="el-icon-switch-button" @click="handleDisableTag(scope.row)" v-hasPermi="['plc:tag:remove']">停用</el-button>
            <el-button size="mini" type="text" icon="el-icon-delete" style="color: #F56C6C" @click="handleDeleteTag(scope.row)" v-hasPermi="['plc:tag:remove']">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <pagination v-show="tagTotal>0" :total="tagTotal" :page.sync="tagQueryParams.pageNum" :limit.sync="tagQueryParams.pageSize" @pagination="getTagList" />
    </el-dialog>

    <!-- 新增/编辑点位对话框 -->
    <el-dialog :title="tagFormTitle" :visible.sync="tagFormOpen" width="90%" :class="'dialog-md'" append-to-body>
      <el-form ref="tagFormRef" :model="tagForm" :rules="tagRules" label-width="110px">
        <el-tabs v-model="tagActiveTab">
          <el-tab-pane label="基本信息" name="basic">
            <el-form-item label="点位名称" prop="tagName">
              <el-input v-model="tagForm.tagName" placeholder="如：1号炉温度（给人看的名称）" />
            </el-form-item>
            <el-form-item label="点位类型">
              <el-radio-group v-model="tagKind" @change="onTagKindChange">
                <el-radio label="collect">采集点位</el-radio>
                <el-radio label="calc">计算点位</el-radio>
              </el-radio-group>
              <span style="font-size:11px;color:#999;margin-left:8px">计算点位=同设备其他点位的 和/平均/最大/最小，不读寄存器</span>
            </el-form-item>
            <!-- 计算点位配置 -->
            <template v-if="isCalcTag">
              <el-form-item label="计算方式" prop="calcOp">
                <el-select v-model="tagForm.calcOp" style="width: 100%">
                  <el-option label="和（sum）" value="sum" />
                  <el-option label="平均（avg）" value="avg" />
                  <el-option label="最大（max）" value="max" />
                  <el-option label="最小（min）" value="min" />
                </el-select>
              </el-form-item>
              <el-form-item label="来源点位" prop="calcSourceIds">
                <el-select v-model="tagForm.calcSourceIds" multiple collapse-tags style="width: 100%" placeholder="选择本设备的采集点位（可多选）">
                  <el-option v-for="t in calcSourceOptions" :key="t.id" :label="(t.tagName || '') + '（' + (t.registerType || '') + (t.registerAddress || '') + '）'" :value="t.id" />
                </el-select>
                <span style="font-size:11px;color:#999">仅限本设备的启用采集点位；源失效时用其最近有效值续算（结果标 UNCERTAIN）</span>
              </el-form-item>
            </template>
            <el-form-item label="寄存器类型" prop="registerType" v-if="!isCalcTag">
              <el-select v-model="tagForm.registerType" placeholder="请选择寄存器类型" style="width: 100%" @change="onRegisterTypeChange">
                <el-option v-for="r in availableRegisterTypes" :key="r.value" :label="r.label" :value="r.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="寄存器地址" prop="registerAddress" v-if="!isCalcTag">
              <el-input v-model="tagForm.registerAddress" placeholder="如：111（D寄存器的地址编号）" />
            </el-form-item>
            <el-form-item label="数据类型" prop="dataType">
              <el-select v-model="tagForm.dataType" placeholder="请选择数据类型" style="width: 100%">
                <el-option v-for="dt in availableDataTypes" :key="dt.value" :label="dt.label" :value="dt.value" />
              </el-select>
            </el-form-item>
            <!-- 位偏移：驱动支持且数据类型为 BIT/BOOL 时显示 -->
            <el-form-item label="位偏移" prop="bitOffset" v-if="!isCalcTag && driverBitOffsetSupported && isBitDataType">
              <el-input-number v-model="tagForm.bitOffset" :min="0" :max="15" style="width: 100%" />
            </el-form-item>
            <!-- 字节序：驱动支持且多字节数据类型时显示 -->
            <el-form-item label="字节序" prop="byteOrder" v-if="!isCalcTag && driverByteOrderSupported && isMultiByteDataType">
              <el-select v-model="tagForm.byteOrder" placeholder="请选择字节序" style="width: 100%">
                <el-option label="大端 (BIG_ENDIAN)" value="BIG_ENDIAN" />
                <el-option label="小端 (LITTLE_ENDIAN)" value="LITTLE_ENDIAN" />
              </el-select>
            </el-form-item>
            <!-- 字序：驱动支持且跨字数据类型时显示 -->
            <el-form-item label="字序" prop="wordOrder" v-if="!isCalcTag && driverWordOrderSupported && isCrossWordDataType">
              <el-select v-model="tagForm.wordOrder" placeholder="请选择字序" style="width: 100%">
                <el-option label="高位在前 (HIGH_FIRST)" value="HIGH_FIRST" />
                <el-option label="低位在前 (LOW_FIRST)" value="LOW_FIRST" />
              </el-select>
            </el-form-item>
            <el-form-item label="单位" prop="unit">
              <el-input v-model="tagForm.unit" placeholder="PLC寄存器原始单位，如：无" />
            </el-form-item>
            <el-row>
              <el-col :span="12">
                <el-form-item label="排序号" prop="sortOrder">
                  <el-input-number v-model="tagForm.sortOrder" :min="0" :max="9999" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="状态" prop="status">
                  <el-radio-group v-model="tagForm.status">
                    <el-radio label="0">启用</el-radio>
                    <el-radio label="1">停用</el-radio>
                  </el-radio-group>
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="描述" prop="description">
              <el-input v-model="tagForm.description" type="textarea" placeholder="请输入点位描述" :rows="2" />
            </el-form-item>
          </el-tab-pane>
          <el-tab-pane label="换算配置" name="transform">
            <el-form-item label="换算类型" prop="transformType">
              <el-select v-model="tagForm.transformType" placeholder="选择换算类型" style="width: 100%">
                <el-option label="无换算（原值）" value="none" />
                <el-option label="线性 y=a·x+b" value="linear" />
                <el-option label="斜率偏移（量程映射）" value="slope_offset" />
              </el-select>
            </el-form-item>
            <el-row>
              <el-col :span="12">
                <el-form-item label="斜率/乘数 a">
                  <el-input-number v-model="tagForm.transformSlopeA" :min="0" :precision="3" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="偏移量 b">
                  <el-input-number v-model="tagForm.transformOffsetB" :precision="3" style="width: 100%" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="工程单位" prop="engUnit">
              <el-input v-model="tagForm.engUnit" placeholder="换算后的显示单位，如：℃、MPa" />
            </el-form-item>
            <el-divider content-position="left">上报策略</el-divider>
            <el-row>
              <el-col :span="12">
                <el-form-item label="变化死区（数值）">
                  <el-input-number v-model="tagForm.reportDeadbandMs" :min="0" :max="1000000" :step="0.1" :precision="2" style="width: 100%" />
                  <span style="font-size:11px;color:#999">数值死区（工程单位）：变化量小于此值不上报，0=每次上报</span>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="强制间隔">
                  <el-input-number v-model="tagForm.reportForceIntervalMs" :min="1000" :max="600000" :step="1000" style="width: 100%" />
                  <span style="font-size:11px;color:#999">毫秒：值未变也强制写一条（保活）</span>
                </el-form-item>
              </el-col>
            </el-row>
          </el-tab-pane>
        </el-tabs>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button type="primary" @click="submitTagForm">确 定</el-button>
          <el-button @click="tagFormOpen = false">取 消</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script>
import { listDevice, getDevice, addDevice, updateDevice, delDevice, disableDevice, cloneDevice, toggleDeviceStatus, getProtocolCompat, getDriverSchema } from "@/api/plc/device";
import { listTag, getTag, addTag, updateTag, delTag, disableTag, downloadTagTemplate, importTags, toggleTagStatus } from "@/api/plc/tag";
import { download } from "@/utils/request";

export default {
  name: "PlcDevice",
  data() {
    return {
      loading: true,
      ids: [],
      single: true,
      multiple: true,
      showSearch: true,
      submitting: false,    // 表单提交中/加载中锁
      total: 0,
      deviceList: [],
      title: "",
      open: false,
      activeTab: 'basic',
      queryParams: {
        pageNum: 1,
        pageSize: 10,
        deviceName: null,
        deviceCode: null,
        plcIp: null,
        status: null,
        plcBrand: null,
      },
      form: {},
      fxFrameDisabled: false,
      // 品牌→系列→通信方式级联配置
      brandConfig: null,
      // 当前设备驱动 schema（config_schema / register_types / data_types）
      driverSchema: {},
      // 克隆
      cloneOpen: false,
      cloneForm: { sourceId: null, sourceName: '', deviceName: '', deviceCode: '', plcIp: '' },
      cloneRules: {
        deviceName: [{ required: true, message: '新设备名称不能为空', trigger: 'blur' }],
        deviceCode: [{ required: true, message: '新设备编号不能为空', trigger: 'blur' }],
        plcIp: [
          { required: true, message: '新PLC IP不能为空', trigger: 'blur' },
          { pattern: /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/, message: '请输入正确的IP地址格式', trigger: 'blur' }
        ],
      },
      rules: {
        deviceName: [
          { required: true, message: "设备名称不能为空", trigger: "blur" }
        ],
        plcBrand: [
          { required: true, message: "PLC品牌不能为空", trigger: "change" }
        ],
        hostPcIp: [
          { required: true, message: "采集节点不能为空", trigger: "blur" },
          { pattern: /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(:\d{1,5})?$/, message: "请输入正确的IP地址格式（支持 IP:端口）", trigger: "blur" }
        ],
        plcIp: [
          { required: true, message: "PLC IP地址不能为空", trigger: "blur" },
          { pattern: /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/, message: "请输入正确的IP地址格式", trigger: "blur" }
        ],
        mesIp: [
          { required: true, message: "工业内网IP不能为空", trigger: "blur" },
          { pattern: /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/, message: "请输入正确的IP地址格式", trigger: "blur" }
        ],
        backupPcIp: [
          { pattern: /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(:\d{1,5})?$/, message: "请输入正确的IP地址格式（支持 IP:端口）", trigger: "blur" }
        ],
        plcPort: [
          { required: true, message: "PLC端口号不能为空", trigger: "blur" }
        ],
        plcSeries: [
          { required: true, message: "PLC系列不能为空", trigger: "change" }
        ],
        comType: [
          { required: true, message: "通信方式不能为空", trigger: "change" }
        ],
      },
      // === 点位管理相关 ===
      tagOpen: false,
      tagDialogTitle: "",
      tagLoading: false,
      tagTotal: 0,
      tagList: [],
      tagIds: [],
      tagMultiple: true,
      tagSingle: true,
      currentDevice: {},
      tagQueryParams: {
        pageNum: 1,
        pageSize: 10,
        tagName: null,
        status: null,
      },
      // 导入结果
      importResultOpen: false,
      importResult: { successCount: 0, failCount: 0, errors: [] },
      // 点位表单
      tagFormOpen: false,
      tagFormTitle: "",
      tagActiveTab: 'basic',
      tagForm: {},
      bitOnly: false,  // X/Y/M 时只允许选 BIT
      tagKind: 'collect',  // 点位类型：collect=采集 calc=计算（派生）
      tagRules: {
        tagName: [
          { required: true, message: "点位名称不能为空", trigger: "blur" }
        ],
        registerType: [
          { required: true, message: "寄存器类型不能为空", trigger: "change" }
        ],
        registerAddress: [
          { required: true, message: "寄存器地址不能为空", trigger: "blur" }
        ],
        dataType: [
          { required: true, message: "数据类型不能为空", trigger: "change" }
        ],
      },
    };
  },
  computed: {
    brandList() {
      var cfg = this.brandConfig || {};
      return Object.keys(cfg)
        .filter(function(k){ return !k.startsWith('_'); })
        .map(function(k){ return { label:k, value:k }; });
    },
    // P0-1: 兼容设备编辑对话框(form) 和 点位管理(currentDevice) 两个场景
    _deviceCtx() {
      return (this.currentDevice && this.currentDevice.plcBrand) ? this.currentDevice : this.form;
    },
    _ctxDriverCode() {
      // 优先取驱动 schema 对应的设备上下文
      var dev = this._deviceCtx;
      return dev.driverCode || 'UNKNOWN';
    },
    availableSeries() {
      var dev = this._deviceCtx;
      var b = this.brandConfig || {};
      var cfg = b[dev.plcBrand];
      return cfg ? cfg.series : [];
    },
    availableComTypes() {
      var dev = this._deviceCtx;
      var b = this.brandConfig || {};
      var cfg = b[dev.plcBrand];
      if (!cfg) return [];
      var series = (cfg.series||[]).find(function(s){ return s.value === dev.plcSeries; });
      if (!series) return [];
      return (series.comTypes||[]).map(function(c){
        return { label:c.label, value:c.value, isDefault:c.isDefault };
      });
    },
    driverSchemaFields() {
      var schema = this.driverSchema || {};
      var fields = (schema.configSchema && schema.configSchema.fields) || [];
      return fields;
    },
    driverBitOffsetSupported() {
      return !!(this.driverSchema && this.driverSchema.bitOffsetSupported);
    },
    driverByteOrderSupported() {
      return !!(this.driverSchema && this.driverSchema.byteOrderSupported);
    },
    driverWordOrderSupported() {
      return !!(this.driverSchema && this.driverSchema.wordOrderSupported);
    },
    /** 计算点位判定（表单切换驱动） */
    isCalcTag() {
      return this.tagKind === 'calc';
    },
    /** 计算点位来源候选：本设备启用中的采集点位（排除计算点位与自身） */
    calcSourceOptions() {
      var selfId = this.tagForm && this.tagForm.id;
      return (this.tagList || []).filter(function (t) {
        return t.status === '0' && !t.calcOp && t.id !== selfId;
      });
    },
    availableRegisterTypes() {
      // 优先按驱动 schema 返回的寄存器类型渲染；schema 未加载时回退到 brandConfig
      var schema = this.driverSchema || {};
      var rtList = (schema.registerTypes || []);
      if (rtList.length > 0) {
        return rtList.map(function(r){ return { label: r.label || r.value, value: r.value, dataTypes: r.dataTypes || [] }; });
      }
      // 回退：兼容旧 brandConfig
      var dev = this._deviceCtx;
      var b = this.brandConfig || {};
      var cfg = b[dev.plcBrand];
      if (!cfg) return [];
      var series = (cfg.series||[]).find(function(s){ return s.value === dev.plcSeries; });
      if (!series) return [];
      var ct = (series.comTypes||[]).find(function(c){ return c.value === dev.comType; });
      if (!ct) return [];
      return ct.registerTypes||[];
    },
    availableDataTypes() {
      // 按当前选中的寄存器类型过滤数据类型
      var rt = (this.availableRegisterTypes || []).find(function(r){ return r.value === (this.tagForm && this.tagForm.registerType); }.bind(this));
      var allowed = rt && rt.dataTypes ? rt.dataTypes : [];
      var all = [
        { value: 'BIT', label: 'BIT（位）' },
        { value: 'BOOL', label: 'BOOL（布尔）' },
        { value: 'INT16', label: 'INT16（16位有符号整数）' },
        { value: 'UINT16', label: 'UINT16（16位无符号整数）' },
        { value: 'INT32', label: 'INT32（32位有符号整数）' },
        { value: 'UINT32', label: 'UINT32（32位无符号整数）' },
        { value: 'FLOAT', label: 'FLOAT（32位浮点）' },
        { value: 'DOUBLE', label: 'DOUBLE（64位浮点）' },
      ];
      if (allowed.length > 0) {
        return all.filter(function(dt){ return allowed.indexOf(dt.value) >= 0; });
      }
      return all;
    },
    isBitDataType() {
      return this.tagForm && (this.tagForm.dataType === 'BIT' || this.tagForm.dataType === 'BOOL');
    },
    isMultiByteDataType() {
      return this.tagForm && ['INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT', 'DOUBLE'].indexOf(this.tagForm.dataType) >= 0;
    },
    isCrossWordDataType() {
      return this.tagForm && ['INT32', 'UINT32', 'FLOAT', 'DOUBLE'].indexOf(this.tagForm.dataType) >= 0;
    },
  },
  created() {
    this.getList();
    // P0-2: 加载链 — 先读缓存(10分钟) → API → 保底空对象（缓存短周期，后端配置变更最多10分钟内生效）
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem('plc_brand_config')); } catch(e) {}
    if (cached && cached._ts && (Date.now() - cached._ts < 600000)) {
      this.brandConfig = cached;
    } else {
      // 缓存失效或不存在，先用最小保底防页面白屏，等 API 更新
      this.brandConfig = {};
    }
    getProtocolCompat().then(function(res){
      if (res.code === 200 && (res.msg || res.data)) {
        var cfg = res.data || res.msg;
        cfg._ts = Date.now();
        this.brandConfig = cfg;
        localStorage.setItem('plc_brand_config', JSON.stringify(cfg));
      }
    }.bind(this)).catch(function(){
      // 网络故障时保持缓存值不变
    }.bind(this));
  },
  methods: {
    /** 品牌变更时重置系列和通信方式 */
    onBrandChange(value) {
      this.form.plcSeries = null;
      this.form.comType = null;
      this.form.driverCode = null;
      this.driverSchema = {};
      this.form.mcFrame = '3E';
      if (this.tagFormOpen) {
        this.$modal.msgWarning('设备品牌已变更，请重新确认点位配置的寄存器类型');
        this.tagFormOpen = false;
      }
    },

    /** PLC系列变更时重置通信方式+帧格式 */
    onSeriesChange(value) {
      // 通信方式重置，防跨系列保留不兼容值
      this.form.comType = null;
      this.form.driverCode = null;
      this.driverSchema = {};
      // FX 系列固定 3E，iQ-R 默认 4E，其他默认 3E
      if (value === 'FX') {
        this.fxFrameDisabled = true;
        this.form.mcFrame = '3E';
      } else if (value === 'iQ-R') {
        this.fxFrameDisabled = false;
        this.form.mcFrame = '4E';
      } else {
        this.fxFrameDisabled = false;
        this.form.mcFrame = '3E';
      }
    },

    /** 通信方式变更时调整表单显隐和校验规则，并加载对应驱动 schema */
    onComTypeChange(value) {
      this.applyComTypeRules(value);
      // 加载驱动 schema（会填充 driverCode 和协议参数默认值）
      this.loadDriverSchema();
    },

    /** 按通信方式设置 plcIp / plcPort 的校验规则 */
    applyComTypeRules(value) {
      // 注意：切换到 RS-232C 时不清空 plcIp，仅隐藏输入框；
      // 用户手动清空是明确意图，不清空则保留原值以便切回时恢复
      const IP_REGEX = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
      this.rules.plcIp = (value === 'PLC_RS232C')
        ? []
        : [{ required: true, message: "PLC IP地址不能为空", trigger: "blur" }, { pattern: IP_REGEX, message: "请输入正确的IP地址格式", trigger: "blur" }];
      this.rules.plcPort = (value === 'PLC_RS232C')
        ? []
        : [{ required: true, message: "PLC端口号不能为空", trigger: "blur" }];
      // 清除旧校验状态
      this.$nextTick(() => {
        if (this.$refs.form) {
          this.$refs.form.clearValidate(['plcIp', 'plcPort']);
        }
      });
    },

    /** 友好的错误信息映射 */
    friendlyErr(err) {
      var code = err.response && err.response.status;
      if (code === 409) return '数据冲突，请检查设备名称是否重复';
      if (code === 413) return '数据量过大，请分批操作';
      if (code === 401) return '登录已过期，请刷新页面';
      if (code >= 500) return '服务器繁忙，请稍后重试';
      return err.message || '操作失败，请稍后重试';
    },

    /** 查询设备列表 */
    getList() {
      this.loading = true;
      listDevice(this.queryParams).then(response => {
        this.deviceList = (response.rows || []).map(item => {
          // 规范化 status 为字符串（el-switch active-value/inactive-value 要求字符串类型）
          item.status = String(item.status ?? '0')
          return item
        });
        this.total = response.total;
        this.loading = false;
      }).catch(() => {
        this.loading = false;
      });
    },

    cancel() {
      this.open = false;
      this.reset();
    },

    /** 表单重置 */
    reset() {
      this.form = {
        id: null,
        deviceName: null,
        deviceCode: null,
        plcBrand: 'Mitsubishi',
        plcSeries: null,
        comType: null,
        plcIp: null,
        hostPcIp: null,
        backupPcIp: null,
        mesIp: null,
        mesPort: 0,
        plcPort: 5007,
        mcFrame: null,
        stationNo: 0,
        networkNo: 0,
        scanIntervalMs: 1000,
        commTimeoutMs: 3000,
        retryCount: 2,
        retryIntervalMs: 500,
        triggerKind: 0,
        driverCode: null,
        protocolParams: null,
        status: '0',
        remark: null,
      };
      this.fxFrameDisabled = false;
      this.driverSchema = {};
      this.resetForm("form");
    },

    /** 根据 brand/series/comType 解析并加载驱动 schema */
    async loadDriverSchema() {
      var dev = this.form;
      if (!dev.plcBrand || !dev.plcSeries || !dev.comType) {
        this.driverSchema = {};
        this.form.driverCode = null;
        return;
      }
      try {
        // 先从 brandConfig 里找映射（避免每次都调 API）
        var cfg = this.brandConfig || {};
        var brandCfg = cfg[dev.plcBrand];
        var seriesCfg = brandCfg && (brandCfg.series || []).find(function(s){ return s.value === dev.plcSeries; });
        var ctCfg = seriesCfg && (seriesCfg.comTypes || []).find(function(c){ return c.value === dev.comType; });
        var driverCode = ctCfg && ctCfg.driverCode ? ctCfg.driverCode : null;

        // 若 brandConfig 未带 driverCode，交给后端保存时自动解析填充，前端不做硬编码兜底
        this.form.driverCode = driverCode || null;
        if (driverCode && driverCode !== 'UNKNOWN') {
          var res = await getDriverSchema(driverCode);
          if (res.code === 200 && res.data) {
            this.driverSchema = res.data;
            this.applyDriverSchemaDefaults();
            this.applyDriverSchemaRules();
          }
        } else {
          this.driverSchema = {};
        }
      } catch (e) {
        this.driverSchema = {};
        console.warn('[device] 加载驱动 schema 失败:', e);
      }
    },

    /** 将驱动 schema 中的默认值填充到 form（仅当字段为空时） */
    applyDriverSchemaDefaults() {
      var fields = this.driverSchemaFields;
      var self = this;
      var flatFields = self._flatDeviceFields();
      fields.forEach(function(field){
        if (field.default === undefined) return;
        // 🔧 修复P0-2：非平铺字段（unitId/rack/slot/serialPort 等）实际存于 form.protocolParams，
        // 此前读顶层恒 undefined → 守卫失效 → 编辑时被 default 覆盖（静默重置配置）
        var isFlat = flatFields.indexOf(field.name) >= 0;
        var cur = isFlat ? self.form[field.name] : (self.form.protocolParams || {})[field.name];
        if (cur !== null && cur !== undefined && cur !== '') return;
        if (isFlat) {
          self.form[field.name] = field.default;
        } else {
          var pp = self.form.protocolParams || {};
          pp[field.name] = field.default;
          self.form.protocolParams = pp;
        }
      });
    },

    /** 返回 plc_device 表的平铺字段名（与后端 VO 对应） */
    _flatDeviceFields() {
      return [
        'plcPort', 'mcFrame', 'stationNo', 'networkNo',
        'scanIntervalMs', 'commTimeoutMs', 'retryCount',
        'retryIntervalMs', 'triggerKind'
      ];
    },

    /** 将驱动 schema 中非平铺字段收集到 form.protocolParams */
    collectDriverParams() {
      var self = this;
      var flatFields = self._flatDeviceFields();
      var pp = self.form.protocolParams || {};
      self.driverSchemaFields.forEach(function(field){
        if (flatFields.indexOf(field.name) === -1) {
          var val = self.form[field.name];
          if (val !== undefined && val !== null && val !== '') {
            pp[field.name] = val;
          }
          // 避免重复提交到平铺层
          delete self.form[field.name];
        }
      });
      self.form.protocolParams = Object.keys(pp).length > 0 ? pp : null;
    },

    /** 将 protocolParams 中的动态字段展开到 form 顶层，便于动态表单回显 */
    expandProtocolParams() {
      var self = this;
      var flatFields = self._flatDeviceFields();
      var pp = self.form.protocolParams || {};
      self.driverSchemaFields.forEach(function(field){
        if (flatFields.indexOf(field.name) === -1 && pp[field.name] !== undefined) {
          self.form[field.name] = pp[field.name];
        }
      });
    },

    /** 根据驱动 schema 生成表单校验规则 */
    applyDriverSchemaRules() {
      var self = this;
      self.driverSchemaFields.forEach(function(field){
        if (field.required) {
          self.rules[field.name] = [
            { required: true, message: field.label + '不能为空', trigger: field.type === 'select' ? 'change' : 'blur' }
          ];
        } else {
          delete self.rules[field.name];
        }
      });
    },

    handleQuery() {
      this.queryParams.pageNum = 1;
      clearTimeout(this._queryTimer);
      this._queryTimer = setTimeout(() => { this.getList(); }, 200);
    },

    resetQuery() {
      this.resetForm("queryForm");
      this.handleQuery();
    },

    handleSelectionChange(selection) {
      this.ids = selection.map(item => item.id);
      this.single = selection.length != 1;
      this.multiple = !selection.length;
    },

    handleAdd() {
      this.reset();
      this.activeTab = 'basic';
      this.open = true;
      this.title = "添加PLC设备";
    },

    handleUpdate(row) {
      // P0-3: 不先清空 — API 返回前用 loading 遮罩防闪烁
      this.fxFrameDisabled = false;
      this.currentDevice = row;  // 点位 tab 内新增/编辑需用 currentDevice 联动寄存器类型
      this.open = true;
      this.title = "修改PLC设备";
      this.activeTab = 'basic';
      this.submitting = true;
      const id = row.id || this.ids[0];
      getDevice(id).then(response => {
        this.form = response.data;
        if (this.form.plcSeries === 'FX') {
          this.fxFrameDisabled = true;
        }
        // 加载驱动 schema 并按通信方式设置校验规则（避免 onComTypeChange 重复触发 schema 加载）
        this.loadDriverSchema().then(() => {
          this.applyComTypeRules(this.form.comType);
          this.expandProtocolParams();
        });
        this.submitting = false;
      }).catch(() => {
        this.open = false;
        this.submitting = false;
      });
    },

    submitForm() {
      this.$refs["form"].validate(valid => {
        if (valid) {
          // 收集动态驱动参数到 protocolParams，避免非平铺字段被后端 VO 丢弃
          this.collectDriverParams();
          if (this.form.id != null) {
            updateDevice(this.form).then(response => {
              this.$modal.msgSuccess("修改成功，请前往【配置发布中心】下发到采集节点");
              this.open = false;
              this.getList();
            }).catch(err => {
              this.$modal.msgError(this.friendlyErr(err));
            });
          } else {
            addDevice(this.form).then(response => {
              this.$modal.msgSuccess("新增成功，请前往【配置发布中心】下发到采集节点");
              this.open = false;
              this.getList();
            }).catch(err => {
              this.$modal.msgError(this.friendlyErr(err));
            });
          }
        }
      });
    },

    /** 停用设备（status='1'） */
    handleDisable(row) {
      const ids = row.id || this.ids.join(',');
      this.$modal.confirm('停用编号为"' + ids + '"的设备？（停用后需到【配置发布中心】发布才会停止采集，已写入数据保留。确认停用？）').then(function() {
        return disableDevice(ids);
      }).then(() => {
        this.getList();
        this.$modal.msgSuccess("停用成功，发布中心发布后停止采集");
      }).catch(() => {});
    },

    /** 删除设备（del_flag='2'） */
    handleDelete(row) {
      const ids = row.id || this.ids.join(',');
      this.$modal.confirm('是否确认删除编号为"' + ids + '"的设备？（将同时删除其下所有点位，数据不可恢复）').then(function() {
        return delDevice(ids);
      }).then(() => {
        this.getList();
        this.$modal.msgSuccess("删除成功");
      }).catch(() => {});
    },

    // ==================== 克隆 ====================

    /** 打开克隆对话框 */
    handleClone(row) {
      // 剥离历次克隆叠加的 _CP_xxxx / _副本 后缀，取"根"名称再拼新后缀——
      // 否则 device_code 会无限变长，最终撑爆 varchar(50) 列（DataError 1406）
      const baseCode = (row.deviceCode || '').replace(/(_CP_[a-z0-9]+)+$/i, '');
      const baseName = (row.deviceName || '').replace(/(_副本\d*)+$/, '');
      this.cloneForm = {
        sourceId: row.id,
        sourceName: row.deviceName,
        deviceName: baseName + '_副本',
        deviceCode: baseCode + '_CP_' + Date.now().toString(36),
        plcIp: '',
      };
      this.cloneOpen = true;
    },

    /** 提交克隆 */
    submitClone() {
      this.$refs['cloneForm'].validate(valid => {
        if (valid) {
          cloneDevice(this.cloneForm.sourceId, {
            new_device_name: this.cloneForm.deviceName,
            new_device_code: this.cloneForm.deviceCode,
            new_plc_ip: this.cloneForm.plcIp,
          }).then(response => {
            this.$modal.msgSuccess(response.msg || '克隆成功');
            this.cloneOpen = false;
            this.getList();
          }).catch(err => {
            this.$modal.msgError(this.friendlyErr(err));
          });
        }
      });
    },

    /** 导出设备列表 */
    handleExport() {
      download('plc/device/export', { ...this.queryParams }, `plc_device_${new Date().getTime()}.xlsx`);
    },

    // ==================== 点位管理 ====================

    handleManageTag(row) {
      this.currentDevice = row;
      this.tagDialogTitle = '【' + row.deviceName + '】点位管理';
      this.tagQueryParams.pageNum = 1;
      this.tagOpen = true;
      this.getTagList();
    },

    getTagList() {
      this.tagLoading = true;
      listTag(this.currentDevice.id, this.tagQueryParams).then(response => {
        this.tagList = response.rows;
        this.tagTotal = response.total;
        this.tagLoading = false;
      }).catch(() => {
        this.tagLoading = false;
      });
    },

    tagDialogClose() {
      this.currentDevice = {};
      this.tagList = [];
      this.tagTotal = 0;
      this.tagQueryParams.pageNum = 1;
      this.tagQueryParams.pageSize = 10;
    },

    handleTagSelectionChange(selection) {
      this.tagIds = selection.map(item => item.id);
      this.tagSingle = selection.length != 1;
      this.tagMultiple = !selection.length;
    },

    resetTagForm() {
      this.bitOnly = false;  // P1-4: 防止位元件限制残留到下一个点位
      this.tagKind = 'collect';
      this.tagForm = {
        id: null,
        deviceId: this.currentDevice.id,
        tagName: null,
        registerType: null,
        registerAddress: null,
        dataType: null,
        bitOffset: null,
        byteOrder: null,
        wordOrder: null,
        unit: null,
        description: null,
        status: '0',
        sortOrder: 0,
        transformType: 'none',
        transformSlopeA: 1.0,
        transformOffsetB: 0.0,
        engUnit: null,
        reportDeadbandMs: 0,
        reportForceIntervalMs: 5000,
        calcOp: null,
        calcSourceIds: [],
      };
      this.bitOnly = false;
      this.tagActiveTab = 'basic';
    },

    /** 点位类型切换：计算点位给占位寄存器字段与默认算子，切回采集则清空计算配置 */
    onTagKindChange(kind) {
      if (kind === 'calc') {
        this.tagForm.calcOp = this.tagForm.calcOp || 'sum';
        this.tagForm.calcSourceIds = this.tagForm.calcSourceIds || [];
        this.tagForm.dataType = 'DOUBLE';
      } else {
        this.tagForm.calcOp = null;
        this.tagForm.calcSourceIds = [];
      }
      // 切换后重跑校验（隐藏的表单项不参与校验）
      this.$nextTick(() => {
        this.$refs.tagFormRef && this.$refs.tagFormRef.clearValidate();
      });
    },

    /** 寄存器类型变更时联动数据类型（按驱动 schema 中 registerType.dataTypes 过滤） */
    onRegisterTypeChange(value) {
      var rt = (this.availableRegisterTypes||[]).find(function(r){ return r.value === value; });
      var allowed = rt && rt.dataTypes ? rt.dataTypes : [];
      if (allowed.length > 0) {
        // 若当前数据类型不在允许列表，则重置
        if (!allowed.includes(this.tagForm.dataType)) {
          // 位类型优先 BIT，否则默认取列表第一项
          var bitTypes = ['BIT', 'BOOL'];
          var isBitReg = allowed.some(function(dt){ return bitTypes.indexOf(dt) >= 0; }) && allowed.length <= 2;
          this.tagForm.dataType = isBitReg ? (allowed.find(function(dt){ return bitTypes.indexOf(dt) >= 0; }) || allowed[0]) : allowed[0];
        }
      }
    },

    handleAddTag() {
      this.resetTagForm();
      this.tagFormTitle = "添加采集点位";
      this.tagFormOpen = true;
    },

    handleUpdateTag(row) {
      this.resetTagForm();
      getTag(row.id).then(response => {
        this.tagForm = response.data;
        // 计算点位回显：calcSourceIds 是 JSON 字符串，多选框需要数组
        if (this.tagForm.calcOp) {
          this.tagKind = 'calc';
          try {
            this.tagForm.calcSourceIds = JSON.parse(this.tagForm.calcSourceIds || '[]');
          } catch (e) {
            this.tagForm.calcSourceIds = [];
          }
        }
        this.tagFormTitle = "修改采集点位";
        this.tagFormOpen = true;
      }).catch(err => {
        this.$modal.msgError(this.friendlyErr(err) || '获取点位详情失败');
      });
    },

    submitTagForm() {
      this.$refs["tagFormRef"].validate(valid => {
        if (valid) {
          if (this.tagForm.id != null) {
            updateTag(this.tagForm).then(response => {
              this.$modal.msgSuccess("修改成功，请前往【配置发布中心】下发到采集节点");
              this.tagFormOpen = false;
              this.getTagList();
            }).catch(err => {
              this.$modal.msgError(this.friendlyErr(err));
            });
          } else {
            addTag(this.tagForm).then(response => {
              this.$modal.msgSuccess("新增成功，请前往【配置发布中心】下发到采集节点");
              this.tagFormOpen = false;
              this.getTagList();
            }).catch(err => {
              this.$modal.msgError(this.friendlyErr(err));
            });
          }
        }
      });
    },

    /** 停用点位（status='1'） */
    handleDisableTag(row) {
      const ids = row.id || this.tagIds.join(',');
      this.$modal.confirm('是否确认停用编号为"' + ids + '"的点位？（Node-RED 将停止采集，数据保留可见）').then(function() {
        return disableTag(ids);
      }).then(() => {
        this.getTagList();
        this.$modal.msgSuccess("停用成功");
      }).catch(() => {});
    },

    /** 删除点位（del_flag='2'） */
    handleDeleteTag(row) {
      const ids = row.id || this.tagIds.join(',');
      this.$modal.confirm('是否确认删除编号为"' + ids + '"的点位？（数据不可恢复）').then(function() {
        return delTag(ids);
      }).then(() => {
        this.getTagList();
        this.$modal.msgSuccess("删除成功");
      }).catch(() => {});
    },

    /** 下载点位导入模板 */
    handleDownloadTemplate() {
      downloadTagTemplate().then(response => {
        const blob = new Blob([response]);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = '点位导入模板.xlsx';
        link.click();
        this.$modal.msgSuccess('模板下载成功');
      });
    },

    /** 设备开关切换 */
    handleDeviceStatusChange(row) {
      const newStatus = row.status;
      const oldStatus = newStatus === '0' ? '1' : '0';
      toggleDeviceStatus(row.id, newStatus).then(() => {
        this.$modal.msgSuccess((newStatus === '0' ? '已启用' : '已停用') + '，发布中心发布后生效');
      }).catch(() => {
        row.status = oldStatus;
        this.$modal.msgError('状态切换失败');
      });
    },

    /** 点位开关切换 */
    handleTagStatusChange(row) {
      const newStatus = row.status;
      const oldStatus = newStatus === '0' ? '1' : '0';
      toggleTagStatus(row.id, newStatus).then(() => {
        this.$modal.msgSuccess((newStatus === '0' ? '已启用' : '已停用') + '，发布中心发布后生效');
      }).catch(() => {
        row.status = oldStatus;
        this.$modal.msgError('状态切换失败');
      });
    },

    /** 上传导入文件 */
    handleBeforeUpload(file) {
      // 文件类型校验
      const validExt = ['.xlsx', '.xls', '.json'];
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      if (validExt.indexOf(ext) < 0) {
        this.$modal.msgError('仅支持 .xlsx / .xls / .json 文件');
        return false;
      }
      // 文件大小校验（10MB）
      const maxSize = 10 * 1024 * 1024;
      if (file.size > maxSize) {
        this.$modal.msgError('文件大小不能超过 10MB');
        return false;
      }
      const formData = new FormData();
      formData.append('file', file);
      importTags(this.currentDevice.id, formData).then(response => {
        this.importResult = response.data || { successCount: 0, failCount: 0, errors: [] };
        this.importResultOpen = true;
        this.getTagList();
      }).catch(err => {
        this.$modal.msgError(this.friendlyErr(err));
      });
      return false; // 阻止 el-upload 默认上传
    },
  },
  beforeDestroy() {
    if (this._queryTimer) {
      clearTimeout(this._queryTimer);
      this._queryTimer = null;
    }
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

/* 对话框宽度限制（pc端有最大宽度，移动端占满） */
::v-deep .dialog-md .el-dialog { max-width: 750px; }
::v-deep .dialog-sm .el-dialog { max-width: 520px; }
::v-deep .dialog-lg .el-dialog { max-width: 1050px; }

/* 表格横向滚动 */
::v-deep .el-table {
  min-width: 800px;
}
::v-deep .el-dialog .el-table {
  min-width: 600px;
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

  /* 对话框全屏 */
  ::v-deep .el-dialog {
    width: 96% !important;
    margin: 10px auto !important;
  }

  /* 表单tabs在小屏上堆叠 */
  ::v-deep .el-tabs__nav {
    white-space: nowrap;
    overflow-x: auto;
  }

  /* 表格容器横向滚动 */
  .app-container {
    overflow-x: auto;
  }

  /* 设备详情表单label缩短 */
  ::v-deep .el-form-item__label {
    width: 80px !important;
    font-size: 13px;
  }

  /* 点位设备信息条文字换行 */
  ::v-deep .el-alert__title {
    word-break: break-all;
    font-size: 12px;
  }
}
</style>
