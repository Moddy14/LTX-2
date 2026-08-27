from __future__ import annotations

import importlib.util
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from types import ModuleType

RUNTIME_ROOT = Path(__file__).resolve().parents[1]


def load_verifier() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "ltx_studio_runtime_verifier",
        RUNTIME_ROOT / "verify_runtime.py",
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load native runtime verifier")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFIER = load_verifier()


class DiffVaeLockContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.pyproject_text = (RUNTIME_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        cls.lock_text = (RUNTIME_ROOT / "uv.lock").read_text(encoding="utf-8")

    def verify(self, *, pyproject_text: str | None = None, lock_text: str | None = None) -> None:
        with tempfile.TemporaryDirectory(prefix="ltx-runtime-lock-test-") as temporary:
            root = Path(temporary)
            pyproject_path = root / "pyproject.toml"
            lock_path = root / "uv.lock"
            pyproject_path.write_text(pyproject_text or self.pyproject_text, encoding="utf-8")
            lock_path.write_text(lock_text or self.lock_text, encoding="utf-8")
            VERIFIER.verify_diffvae_lock_contract(pyproject_path, lock_path)

    def test_checked_in_lock_activates_exact_natten_wheel(self) -> None:
        self.verify()
        self.assertEqual(
            VERIFIER.EXPECTED_VERSIONS["natten"],
            "0.21.7+torch2130cu132",
        )

    def test_optional_extra_metadata_cannot_replace_active_dependency(self) -> None:
        requirement = f'    "{VERIFIER.EXPECTED_NATTEN_REQUIREMENT}",\n'
        self.assertEqual(self.pyproject_text.count(requirement), 1)
        with self.assertRaisesRegex(SystemExit, "active, exact AArch64 runtime dependency"):
            self.verify(pyproject_text=self.pyproject_text.replace(requirement, ""))

    def test_pyproject_rejects_a_second_natten_requirement(self) -> None:
        requirement = f'    "{VERIFIER.EXPECTED_NATTEN_REQUIREMENT}",\n'
        duplicate = requirement + '    "natten==0.21.7+torch2130cu132",\n'
        with self.assertRaisesRegex(SystemExit, "unexpected NATTEN requirement"):
            self.verify(pyproject_text=self.pyproject_text.replace(requirement, duplicate))

    def test_pyproject_requires_direct_torch_wheel(self) -> None:
        requirement = f'    "{VERIFIER.EXPECTED_TORCH_REQUIREMENT}",\n'
        self.assertEqual(self.pyproject_text.count(requirement), 1)
        with self.assertRaisesRegex(SystemExit, "exact direct Torch"):
            self.verify(pyproject_text=self.pyproject_text.replace(
                requirement,
                '    "torch==2.13.0+cu132",\n',
            ))

    def test_lock_root_must_reference_natten(self) -> None:
        active_dependency = '    { name = "natten" },\n    { name = "openai-whisper" },'
        self.assertEqual(self.lock_text.count(active_dependency), 1)
        with self.assertRaisesRegex(SystemExit, "active root dependency"):
            self.verify(lock_text=self.lock_text.replace(
                active_dependency,
                '    { name = "openai-whisper" },',
            ))

    def test_lock_must_contain_natten_package(self) -> None:
        package_start = self.lock_text.index('\n[[package]]\nname = "natten"\n')
        package_end = self.lock_text.index('\n[[package]]\n', package_start + 2)
        without_natten = self.lock_text[:package_start] + self.lock_text[package_end:]
        with self.assertRaisesRegex(SystemExit, "exactly one natten package"):
            self.verify(lock_text=without_natten)

    def test_lock_rejects_natten_hash_drift(self) -> None:
        self.assertEqual(self.lock_text.count(VERIFIER.EXPECTED_NATTEN_SHA256), 1)
        with self.assertRaisesRegex(SystemExit, "NATTEN AArch64 wheel SHA-256"):
            self.verify(lock_text=self.lock_text.replace(
                VERIFIER.EXPECTED_NATTEN_SHA256,
                "0" * 64,
            ))

    def test_lock_rejects_natten_version_drift(self) -> None:
        package_version = f'version = "{VERIFIER.EXPECTED_NATTEN_VERSION}"'
        self.assertEqual(self.lock_text.count(package_version), 1)
        with self.assertRaisesRegex(SystemExit, "unexpected NATTEN version"):
            self.verify(lock_text=self.lock_text.replace(
                package_version,
                'version = "0.21.6+torch2130cu132"',
            ))

    def test_lock_rejects_torch_pairing_drift(self) -> None:
        torch_hash = VERIFIER.EXPECTED_TORCH_SHA256
        self.assertEqual(self.lock_text.count(torch_hash), 1)
        with self.assertRaisesRegex(SystemExit, "hermetic Torch AArch64 wheel"):
            self.verify(lock_text=self.lock_text.replace(torch_hash, "f" * 64))

    def test_pyproject_must_block_inherited_natten_sources(self) -> None:
        source_guard = 'no-sources-package = ["natten", "torch", "torchaudio", "torchvision"]'
        self.assertEqual(self.pyproject_text.count(source_guard), 1)
        with self.assertRaisesRegex(SystemExit, "ignore inherited uv source overrides"):
            self.verify(pyproject_text=self.pyproject_text.replace(
                source_guard,
                'no-sources-package = ["torch", "torchaudio", "torchvision"]',
            ))

    def test_installed_runtime_fails_closed_when_natten_is_missing(self) -> None:
        def installed_version(name: str) -> str:
            if name == "natten":
                raise VERIFIER.importlib.metadata.PackageNotFoundError(name)
            return VERIFIER.EXPECTED_VERSIONS[name]

        with mock.patch.object(
            VERIFIER.importlib.metadata,
            "version",
            side_effect=installed_version,
        ):
            with self.assertRaisesRegex(SystemExit, "missing required distribution: natten"):
                VERIFIER.verify_installed_distribution_versions()


if __name__ == "__main__":
    unittest.main()
