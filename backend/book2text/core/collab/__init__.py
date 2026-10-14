"""团队协作（说明书 6.7）：审校任务包与结果包的读写与合并。

- `assignments.py`：负责人侧——分派、基准快照、生成 `.b2tpkg`、作废、重新导出；
- `packages.py`：助手侧——打开 `.b2tpkg` 成审校包项目、导出 `.b2tres` 结果包；
- `merge.py`：负责人侧——导入结果包、校验、逐页分类、接受 / 拒绝、冲突处理。

三个模块都不含 HTTP（接口层在 `api/routes_collab.py` 与 `api/routes_packages.py`），
也不自己拼 SQL 之外的业务规则——规则集中在这些模块里，便于单元测试。
"""
