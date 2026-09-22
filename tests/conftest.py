import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parents[1]


if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
os.environ["PYTHONPATH"] = str(REPO_ROOT) + os.pathsep + os.environ.get("PYTHONPATH", "")


@pytest.fixture
def sample_root() -> Path:
    """返回含 pyproject.toml 标记的示例项目根目录。"""
    return Path(__file__).parent / "fixtures" / "sample_project"


def pytest_collection_modifyitems(config, items):
    """依赖 POSIX 绝对路径（/etc/hostname）的用例在 Windows 上跳过。"""
    if sys.platform != "win32":
        return
    skip = pytest.mark.skip(reason="需要 POSIX 路径（/etc/hostname）")
    for item in items:
        if "system_boundary_allows_absolute" in item.name:
            item.add_marker(skip)
