"""Run with the installed Hermes Python; no gateway, provider or profile reads."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_plugin(root=ROOT):
    spec = importlib.util.spec_from_file_location('presenter_fixture', root / '__init__.py', submodule_search_locations=[str(root)])
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    import sys
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class DependencyTests(unittest.TestCase):
    def test_detached_base_python_keeps_activated_dependencies(self):
        import subprocess
        import sys
        import hermes_constants
        from gateway.session_context import set_session_vars, clear_session_vars
        plugin = load_plugin()
        base_python = str(Path(sys.executable).resolve())
        real_popen = subprocess.Popen
        captured = {}

        def dependency_popen(argv, **kwargs):
            captured.update(kwargs['env'])
            # Replace only Node/build/paid boundaries; the real child imports and
            # existing-session attach/detach implementation run in base Python.
            return real_popen([base_python, '-B', str(ROOT / 'tests/dependency-launcher.py')], **kwargs)

        with tempfile.TemporaryDirectory() as tmp:
            class Config:
                def session_surface(self):
                    return 'cli'

                def get_config(self, key, default=None):
                    return {'engine_root': str(ROOT.parent / 'engine'), 'runtime_dir': tmp,
                            'voice': 'fixture-voice'}.get(key, default)

            service = plugin.Service(Config())
            tokens = set_session_vars(session_id='dependency-caller', source='cli')
            # The running gateway has activated sys.path but sanitizes child env.
            # Discard even an existing parent PYTHONPATH to expose that boundary.
            try:
                with patch.object(plugin.sys, 'executable', base_python), patch.dict(os.environ, {
                    'PYTHONPATH': str(Path(hermes_constants.__file__).parent),
                    'PRESENTER_TEST_SECRET': 'must-not-reach-child', 'VIRTUAL_ENV': '/not-the-runtime',
                }), patch.object(plugin, 'get_secret', return_value='fixture-not-a-secret'), \
                        patch('hermes_cli.config.load_config', return_value={}), \
                        patch.object(plugin.subprocess, 'Popen', side_effect=dependency_popen):
                    result = json.loads(service.start({'registered_deck': 'sample', 'approve_share': True,
                                                      'approve_paid': True}, session_id='dependency-caller'))
                logs = '\n'.join(path.read_text() for path in Path(tmp).glob('run-*/service.log'))
                self.assertTrue(result['success'], f'{result}\n{logs}')
                self.assertEqual(service.process.wait(timeout=15), 0)
                self.assertNotIn('PRESENTER_TEST_SECRET', captured)
                self.assertNotIn('VIRTUAL_ENV', captured)
            finally:
                service.close()
                clear_session_vars(tokens)


if __name__ == '__main__':
    unittest.main()
