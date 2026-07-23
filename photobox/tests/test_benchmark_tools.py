import importlib.util
import sys
import unittest
from pathlib import Path


PHOTOBOX_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PHOTOBOX_ROOT))


def load_script(name):
    path = PHOTOBOX_ROOT / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BenchmarkToolTests(unittest.TestCase):
    def test_synthetic_benchmark_is_isolated_and_reports_all_local_operations(self):
        benchmark = load_script("benchmark_local")
        report = benchmark.run(1)
        self.assertFalse(report["productionAcceptance"])
        self.assertEqual(report["iterations"], 1)
        self.assertGreater(report["outputBytes"], 0)
        for name in ("saveSettings", "generate100Vouchers", "startSession", "captureUpload", "completeRender", "enqueuePrint"):
            self.assertGreaterEqual(report["metrics"][name]["samples"], 1)
        self.assertIn("real-camera-capture", report["unmeasured"])


if __name__ == "__main__":
    unittest.main()

