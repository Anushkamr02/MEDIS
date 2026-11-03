from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MODELS = ROOT / "models"
OUT = ROOT / "outputs"
LOGS = ROOT / "logs"
for _p in (DATA, MODELS, OUT, LOGS):
    _p.mkdir(exist_ok=True)

SEED = 42

# Risk bands used on the dashboard (probabilities)
RISK_LOW, RISK_HIGH = 0.33, 0.66
