"""随应用内置的第三方层（只放"必须与产品同版本才不出错"的东西）。

目前只有 Jev 打分层：`jev_score/` 是 MiniCPM-OCR-Jev SDK 的 score 层（纯 Python），
为了做到"点一下就能打分"随包内置。它**不是**我们自己的代码——改动与理由见
`jev_score/NOTICE.md`，升级时整目录替换，别手工改。
"""
