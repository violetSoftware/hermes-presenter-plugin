"""Installed-from-source smoke; only synthetic native/voice doubles, no gateway."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class Relocated(unittest.TestCase):
    def test_registered_handlers_build_selected_decks_paused_and_stop(self):
        from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
        from gateway.session_context import set_session_vars, clear_session_vars
        from tools.registry import registry
        plugin_root = ROOT / 'plugin'
        spec = importlib.util.spec_from_file_location('presenter_candidate', plugin_root / '__init__.py', submodule_search_locations=[str(plugin_root)])
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'HERMES_HOME': tmp}):
            manager = PluginManager(scope_key=tmp)
            ctx = PluginContext(PluginManifest(name='hermes-presenter', path=str(plugin_root)), manager)
            settings = {'engine_root': str(ROOT / 'engine'), 'runtime_dir': str(Path(tmp) / 'state'), 'port': 0, 'voice': 'fixture-voice'}
            handlers = {}
            real_register = ctx.register_tool
            def register(**kwargs):
                handlers[kwargs['name']] = kwargs['handler']
                return real_register(**kwargs)
            with patch.object(ctx, 'session_surface', return_value='cli'), patch.object(ctx, 'get_config', side_effect=lambda key, default=None: settings.get(key, default)), patch.object(ctx, 'register_tool', side_effect=register):
                module.register(ctx)
                definitions = registry.get_definitions(set(handlers), quiet=True)
                self.assertEqual(len(definitions), 3)
                for definition in definitions:
                    function = definition['function']
                    self.assertTrue(function['description'])
                    self.assertEqual(function['parameters']['type'], 'object')
                    self.assertNotIn('session_id', function['parameters'].get('properties', {}))
                real_popen = module.subprocess.Popen
                def popen(argv, **kwargs):
                    return real_popen([argv[0], str(plugin_root / 'tests/launcher-double.mjs')], **kwargs)
                tokens = set_session_vars(session_id='fixture-caller', source='cli', profile='fixture')
                try:
                    for deck in ('sample',):
                        args = {'deck_path': str(plugin_root / deck / 'deck.json'), 'approve_share': True, 'approve_paid': True}
                        with patch.object(module, 'get_secret', return_value='fixture-not-a-secret'), patch('hermes_cli.config.load_config', return_value={}), patch.object(module.subprocess, 'Popen', side_effect=popen):
                            result = json.loads(handlers['presenter_start'](args, session_id='fixture-caller'))
                        self.assertTrue(result['success'], result)
                        self.assertEqual(result['state'], 'paused')
                        origin = result['url'].split('/?')[0]
                        source = json.loads((plugin_root / deck / 'deck.json').read_text())
                        with urllib.request.urlopen(origin + '/presentations/' + source['id'] + '/deck.json') as response:
                            self.assertEqual(json.load(response), source)
                        request = urllib.request.Request(origin + '/presenter-api/connect', data=json.dumps({'deckId': source['id'], 'slideIndex': 0, 'running': True}).encode(), headers={'Origin': origin, 'Content-Type': 'application/json'})
                        with urllib.request.urlopen(request) as response:
                            self.assertEqual(json.load(response)['state']['phase'], 'paused')
                        self.assertFalse(json.loads(handlers['presenter_stop']({}, session_id='wrong'))['success'])
                        stopped = json.loads(handlers['presenter_stop']({}, session_id='fixture-caller'))
                        self.assertTrue(stopped['stopped'])
                        self.assertFalse(stopped['conversation_ended'])
                        with self.assertRaises(Exception):
                            urllib.request.urlopen(result['url'], timeout=1)
                finally:
                    clear_session_vars(tokens)

        print('VERIFIED: 3 real tool schemas; sample handler start -> exact HTTP deck -> paused Connect -> stop; no checkout sources or live sessions/providers')


if __name__ == '__main__':
    unittest.main()
