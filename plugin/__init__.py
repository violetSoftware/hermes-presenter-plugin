"""Native presenter tools. Identity comes only from Hermes's runtime."""
from gateway.session_context import get_session_env
from hermes_constants import get_hermes_home, profile_name_for_home
from agent.secret_scope import get_secret
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import threading
from pathlib import Path


class Service:
    def __init__(self, ctx):
        self.ctx = ctx
        self.process = None
        self.owner = None
        self.url = None
        self.log = None
        self.lock = threading.RLock()

    def start(self, args, session_id=None, **kwargs):
        with self.lock:
            acquired = False
            try:
                owner = caller(session_id, self.ctx)
                if self.process and self.process.poll() is None:
                    if self.owner != owner:
                        raise ValueError('Another conversation owns the presenter. Stop it from that conversation first.')
                    raise ValueError('Presenter already running; stop before loading another deck.')
                if set(args) - {'deck_path', 'registered_deck', 'approve_share', 'approve_paid'}:
                    raise ValueError('Unexpected argument; session identity is runtime-owned.')
                if args.get('approve_share') is not True or args.get('approve_paid') is not True:
                    raise ValueError('Explicit deck sharing and attended model/ElevenLabs cost approval are required.')
                if bool(args.get('deck_path')) == bool(args.get('registered_deck')):
                    raise ValueError('Choose exactly one JSON deck_path or registered_deck.')
                registered = self.ctx.get_config('decks', {})
                path = args.get('deck_path') or ({'sample': str(Path(__file__).parent / 'sample/deck.json'), **registered}.get(args.get('registered_deck')))
                if not path:
                    raise ValueError('Registered deck not found; configure a name or explicitly select a local JSON file.')
                engine = self.ctx.get_config('engine_root', '')
                if not engine or not (Path(engine) / 'server/presenter-http.mjs').is_file():
                    raise ValueError('Set engine_root to a separately installed presenter engine distribution; see README.')
                key = get_secret('ELEVENLABS_API_KEY')
                from hermes_cli.config import load_config
                config = load_config()
                voice = self.ctx.get_config('voice', '') or config.get('tts', {}).get('elevenlabs', {}).get('voice_id', '')
                if not key or not voice:
                    raise ValueError('Configure active-profile ELEVENLABS_API_KEY through Hermes secrets and select tts.elevenlabs.voice_id or presenter voice; no credentials loaded from files.')
                port = self.ctx.get_config('port', 5174)
                if type(port) is not int or not 0 <= port <= 65535:
                    raise ValueError('port must be an integer from 0 to 65535.')
                base = self.ctx.get_config('base_url', '').rstrip('/')
                if base:
                    from urllib.parse import urlsplit
                    parsed = urlsplit(base)
                    if parsed.scheme != 'https' or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
                        raise ValueError('base_url must be an externally established HTTPS origin, without path or credentials.')
                runtime = Path(self.ctx.get_config('runtime_dir', str(Path(owner[1]) / 'plugin-data/hermes-presenter'))).expanduser()
                runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
                directory = tempfile.mkdtemp(prefix='run-', dir=runtime)
                self.log = open(Path(directory) / 'service.log', 'ab', buffering=0)
                acquired = True
                os.chmod(self.log.name, 0o600)
                profile = profile_name_for_home(owner[1]) or get_session_env('HERMES_SESSION_PROFILE') or 'local'
                if not re.fullmatch(r'[A-Za-z0-9_-]+', profile) or not re.fullmatch(r'[A-Za-z0-9_-]+', owner[0]):
                    raise ValueError('Unsupported runtime identity format.')
                # Explicit minimal child environment; never inherit another profile's secrets or paid modes.
                import hermes_constants
                env = {k: os.environ[k] for k in ('PATH', 'HOME', 'LANG', 'TMPDIR') if k in os.environ}
                # sys.executable can be base Python with dependencies activated only
                # in this process. Preserve its import snapshot, not ambient PYTHONPATH
                # or a newly selected PM generation. Never add cwd/relative entries.
                python_paths = dict.fromkeys([str(Path(hermes_constants.__file__).parent),
                    *(entry for entry in sys.path if entry and Path(entry).is_absolute())])
                env.update(HERMES_HOME=owner[1], PYTHONPATH=os.pathsep.join(python_paths), PYTHONDONTWRITEBYTECODE='1')
                payload = dict(engineRoot=str(Path(engine).resolve()), directory=directory, deckPath=str(Path(path).expanduser().resolve()),
                    profile=profile, sessionId=owner[0], python=sys.executable, port=port, baseUrl=base,
                    microphone=self.ctx.get_config('microphone', False), credentials={'key': key, 'voice': voice})
                self.process = subprocess.Popen([self.ctx.get_config('node', 'node'), str(Path(__file__).parent / 'runtime/launcher.mjs')],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, env=env, start_new_session=True)
                self.owner = owner
                assert self.process.stdin is not None and self.process.stdout is not None
                self.process.stdin.write(json.dumps(payload).encode())
                self.process.stdin.close()
                with selectors.DefaultSelector() as selector:
                    selector.register(self.process.stdout, selectors.EVENT_READ)
                    if not selector.select(60):
                        raise ValueError('Presenter build/start timed out; inspect the private service log.')
                    result = json.loads(self.process.stdout.readline(8192))
                if result.get('ready') is not True:
                    raise ValueError('Presenter failed to become ready.')
                self.url = result['url']
                return json.dumps({'success': True, 'url': self.url, 'state': 'paused', 'instructions':
                    'Finish this CLI turn before opening the presenter. Open the URL, click Connect (paused), then explicitly hand over. '
                    'Keep this conversation idle during presentation; later handovers use this same conversation. '
                    'Enable microphone only with browser consent. Stop disconnects the service, not the conversation. '
                    'Selected JSON and its referenced raster assets are shared; model and ElevenLabs usage is billed on attended handovers.'})
            except Exception as error:
                if acquired:
                    self.close()
                return json.dumps({'success': False, 'error': str(error) if isinstance(error, ValueError) else 'Presenter startup failed; check setup and private service log.'})

    def status(self, args, session_id=None, **kwargs):
        with self.lock:
            try:
                if caller(session_id, self.ctx) != self.owner:
                    raise ValueError('This conversation does not own the presenter.')
                return json.dumps({'success': True, 'running': bool(self.process and self.process.poll() is None), 'url': self.url})
            except ValueError as error:
                return json.dumps({'success': False, 'error': str(error)})

    def stop(self, args, session_id=None, **kwargs):
        with self.lock:
            try:
                if caller(session_id, self.ctx) != self.owner:
                    raise ValueError('This conversation does not own the presenter.')
                self.close()
                return json.dumps({'success': True, 'stopped': True, 'conversation_ended': False})
            except ValueError as error:
                return json.dumps({'success': False, 'error': str(error)})

    def close(self):
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    # start_new_session makes this group exclusively ours, including warm helpers.
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=3)
            if self.process.stdout:
                self.process.stdout.close()
            self.process = None
        if self.log:
            self.log.close()
            self.log = None
        self.url = None


def register(ctx):
    service = Service(ctx)
    start = {'type': 'object', 'additionalProperties': False, 'properties': {
        'deck_path': {'type': 'string', 'description': 'Explicitly user-selected local deck JSON; selection grants sharing only this deck and referenced raster assets.'},
        'registered_deck': {'type': 'string', 'description': 'Configured deck name, or sample.'},
        'approve_share': {'type': 'boolean', 'description': 'True only when user intentionally selects this deck for presentation sharing.'},
        'approve_paid': {'type': 'boolean', 'description': 'True only after user approves attended model and ElevenLabs costs; no generation happens until browser handover.'}},
        'required': ['approve_share', 'approve_paid']}
    for name, description, schema, handler in [
        ('presenter_start', 'Start a presentation using a selected JSON deck in THIS calling CLI conversation. Return URL and finish the turn before browser Connect. Never ask for a session ID.', start, service.start),
        ('presenter_status', 'Read status of the presenter owned by this calling conversation.', {'type': 'object', 'properties': {}, 'additionalProperties': False}, service.status),
        ('presenter_stop', 'Stop this conversation’s presenter service and detach; do not end the conversation.', {'type': 'object', 'properties': {}, 'additionalProperties': False}, service.stop)]:
        ctx.register_tool(name=name, toolset='hermes-presenter', schema={'name': name, 'description': description, 'parameters': schema}, handler=handler)
    ctx.on_unload(service.close)



def caller(session_id, ctx=None):
    bound = get_session_env('HERMES_SESSION_ID')
    # Gateway-backed local clients share platform=local. The public context
    # resolves the trusted client policy instead of broadening the transport allowlist.
    source = ctx.session_surface() if ctx is not None else (
        get_session_env('HERMES_SESSION_SOURCE') or get_session_env('HERMES_SESSION_PLATFORM'))
    if not session_id or bound != session_id or source not in ('cli', 'tui', 'desktop'):
        raise ValueError('Presenter requires an identified local CLI conversation; no session argument or fallback.')
    return bound, str(get_hermes_home())
