import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'apps' / 'api'))
import app.db as db
import app.main as main
from app.services import cad_export, agent_orchestrator_engine, paperclip_task_adapter
import pytest

# These legacy tests write demo projects and example credentials. Never use the live DB.
with tempfile.TemporaryDirectory(prefix='atelier-feat033-tests-') as folder:
    temp = Path(folder)
    db.DATA_DIR = temp
    db.DB_PATH = temp / 'atelier.db'
    main.UPLOADS_DIR = temp / 'uploads'
    cad_export.EXPORTS_DIR = temp / 'exports'
    agent_orchestrator_engine.DATA_DIR = temp
    paperclip_task_adapter.PAPERCLIP_BASE_URL = 'http://127.0.0.1:1'
    db.init_db()
    raise SystemExit(pytest.main(sys.argv[1:] or [
        'tests/test_acceptance.py', 'tests/test_workflow_runtime_contract.py',
        'tests/test_concurrent_dag_scheduler.py', 'tests/test_japandi_bedroom_project.py', '-q',
    ]))
