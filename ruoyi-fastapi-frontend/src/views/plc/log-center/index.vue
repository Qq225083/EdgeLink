<template>
  <div class="app-container">
    <el-tabs v-model="activeTab" type="border-card">
      <el-tab-pane label="发布履历" name="publish" lazy>
        <publish-log />
      </el-tab-pane>
      <el-tab-pane label="修改履历" name="change" lazy>
        <change-log />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script>
import PublishLog from "@/views/plc/publish-log/index.vue";
import ChangeLog from "@/views/plc/change-log/index.vue";

export default {
  name: "PlcLogCenter",
  components: { PublishLog, ChangeLog },
  data() {
    return {
      activeTab: 'publish',
    };
  },
};
</script>

<style scoped>
/* 子页面自带 app-container 内边距，嵌套时去掉避免双重边距 */
::v-deep .el-tabs__content > .el-tab-pane > .app-container {
  padding: 0;
}
</style>
