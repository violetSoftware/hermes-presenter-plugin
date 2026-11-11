"""Exercise the base Python child contract without discovery, providers or sessions."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys


async def child(plugin_root):
    # These are real runtime dependencies, not doubles or inherited parent imports.
    import ruamel.yaml
    from websockets.asyncio.client import connect
    assert connect is not None
    assert 'hermes_bootstrap' not in sys.modules
    assert 'PRESENTER_TEST_SECRET' not in os.environ
    assert 'VIRTUAL_ENV' not in os.environ
    assert 'PYTHONHOME' not in os.environ
    spec = importlib.util.spec_from_file_location('detached_existing', plugin_root / 'runtime/existing.py')
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    calls = []

    class Client:
        async def rpc(self, method, **params):
            calls.append(method)
            if method == 'session.resume':
                return {'stored_session_id': params['session_id'], 'running': False,
                        'pending': [], 'prompts': [], 'execution_generation': 0,
                        'subscription_id': 'inert-viewer'}
            if method == 'session.detach':
                return {}
            raise AssertionError('Forbidden native operation: ' + method)

    viewer = await module.attach(Client(), '@session:fixture/dependency-caller')
    await viewer.close()
    assert calls == ['session.resume', 'session.detach'], calls
    assert 'hermes_bootstrap' not in sys.modules
    print(json.dumps({'ready': True, 'url': 'http://dependency-imports-and-attach.invalid/'}), flush=True)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--child':
        asyncio.run(child(Path(sys.argv[2])))
    else:
        config = json.load(sys.stdin)
        result = subprocess.run([config['python'], '-B', __file__, '--child', str(Path(__file__).parents[1])],
                                check=False, timeout=15)
        sys.exit(result.returncode)
