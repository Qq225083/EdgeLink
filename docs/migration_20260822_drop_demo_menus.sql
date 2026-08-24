-- ============================================================
-- 裁剪 RuoYi 上游演示模块的菜单与演示定时任务
-- 背景：初次部署裁剪 module_book / module_japanese / module_generator 后，
--       菜单与调度任务里的演示入口需要同步清除（代码已 git rm）。
-- 内容：
--   1. 系统工具组（表单构建115/代码生成116/系统接口117，父级3清空后一并删）
--   2. 日语学习组（2000/2001/2002）
--   3. 演示定时任务（invoke_target=module_task.scheduler_test.job，代码已删）
-- 注意：先清 sys_role_menu 绑定再删 sys_menu，避免孤儿授权。
-- ============================================================

DELETE FROM sys_role_menu WHERE menu_id IN (115, 116, 117, 3, 2000, 2001, 2002);
DELETE FROM sys_menu WHERE menu_id IN (115, 116, 117, 3, 2000, 2001, 2002);
DELETE FROM sys_job WHERE invoke_target = 'module_task.scheduler_test.job';
