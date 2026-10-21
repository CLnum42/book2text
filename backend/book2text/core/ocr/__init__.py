"""OCR 引擎适配与自检。

- ``base.py``：适配器协议与数据类型（归一化坐标、行结果）；
- ``adapters/``：RapidOCR（第一引擎）与 Apple Vision（macOS 第二引擎）；
- ``selfcheck.py``：报告引擎是否可用，供启动横幅与界面「引擎自检」使用。
"""
