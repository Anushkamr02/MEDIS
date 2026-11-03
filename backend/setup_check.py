"""Read-only setup checks. Training data is checked only with --training."""

import argparse
import importlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME = {
    "numpy": "numpy", "pandas": "pandas", "scipy": "scipy",
    "sklearn": "scikit-learn", "matplotlib": "matplotlib", "joblib": "joblib",
    "cv2": "opencv-python", "pytesseract": "pytesseract", "pdfplumber": "pdfplumber",
    "PIL": "Pillow", "wfdb": "wfdb",
    "fastapi": "fastapi", "uvicorn": "uvicorn", "sqlalchemy": "SQLAlchemy",
    "pydantic": "pydantic", "jwt": "PyJWT", "reportlab": "reportlab",
    "multipart": "python-multipart", "email_validator": "email-validator",
}


def check_setup(*, training=False, ecg=False):
    print("Python", sys.version.split()[0])
    ok = True
    modules = dict(RUNTIME)
    if training or ecg:
        modules["tensorflow"] = "tensorflow"
    for module, package in modules.items():
        try:
            importlib.import_module(module)
            print(f"  OK       {package}")
        except Exception as exc:
            print(f"  MISSING/BROKEN {package}: {type(exc).__name__}: {exc}")
            ok = False
    tesseract = shutil.which("tesseract")
    print("Tesseract binary:", tesseract or "NOT FOUND (required for OCR)")
    ok = ok and bool(tesseract)
    if ecg:
        for name in ("ecg_cnn.keras", "ecg_cnn_norm_params.json"):
            present = (ROOT / "models" / name).is_file()
            print(f"  {'OK' if present else 'MISSING'} models/{name}")
            ok = ok and present
    if training:
        datasets = {
            "data/uci": ("processed.cleveland.data", "processed.hungarian.data",
                         "processed.switzerland.data", "processed.va.data"),
            "data/ptbxl": ("ptbxl_database.csv", "scp_statements.csv", "records100"),
        }
        for folder, names in datasets.items():
            for name in names:
                hits = (ROOT / folder).rglob(name)
                present = any(p.is_dir() if name == "records100" else p.is_file() for p in hits)
                print(f"  {'OK' if present else 'MISSING'} {folder}/{name}")
                ok = ok and present
    print("\nALL GOOD" if ok else "\nFix the MISSING/BROKEN items above, then rerun.")
    return ok


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--training", action="store_true", help="Check training datasets and TensorFlow")
    parser.add_argument("--ecg", action="store_true", help="Check TensorFlow and ECG model artifacts")
    args = parser.parse_args()
    return 0 if check_setup(training=args.training, ecg=args.ecg) else 1


if __name__ == "__main__":
    raise SystemExit(main())
