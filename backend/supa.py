"""Supabase access for the AI service, always as the calling user.

Every request is made with the caller's own access token, so the same RLS
policies the React app relies on decide what the service can read or write.
No service-role key is used.
"""
import os
from pathlib import Path
from urllib.parse import quote

import httpx
from dotenv import dotenv_values
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parent


def _load_config():
    # backend/.env wins; otherwise reuse the frontend's VITE_ values so the
    # service works with no extra setup in local development.
    frontend = {**dotenv_values(ROOT.parent / "frontend" / ".env"),
                **dotenv_values(ROOT.parent / "frontend" / ".env.local")}
    backend = dotenv_values(ROOT / ".env")
    url = os.environ.get("SUPABASE_URL") or backend.get("SUPABASE_URL") or frontend.get("VITE_SUPABASE_URL")
    key = (os.environ.get("SUPABASE_ANON_KEY") or backend.get("SUPABASE_ANON_KEY")
           or frontend.get("VITE_SUPABASE_ANON_KEY"))
    origins = (os.environ.get("ALLOWED_ORIGINS") or backend.get("ALLOWED_ORIGINS")
               or "http://localhost:5173,http://127.0.0.1:5173")
    if not url or not key:
        raise RuntimeError("Set SUPABASE_URL and SUPABASE_ANON_KEY in backend/.env")
    return url.rstrip("/"), key, [o.strip() for o in origins.split(",") if o.strip()]


SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_ORIGINS = _load_config()


class Supa:
    """Thin PostgREST / Storage / Auth client bound to one user's token."""

    def __init__(self, token: str):
        self.token = token
        self.headers = {"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {token}"}

    async def _request(self, method, path, **kwargs):
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.request(method, f"{SUPABASE_URL}{path}",
                                            headers={**self.headers, **kwargs.pop("headers", {})}, **kwargs)
        if response.status_code >= 400:
            raise HTTPException(502 if response.status_code >= 500 else response.status_code,
                                f"Supabase error: {response.text[:300]}")
        return response

    async def user(self):
        """Returns {id, role, full_name} for a valid token, else raises 401."""
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(f"{SUPABASE_URL}/auth/v1/user", headers=self.headers)
        if response.status_code != 200:
            raise HTTPException(401, "Sign in to continue")
        user_id = response.json()["id"]
        rows = await self.select("profiles", {"select": "id,role,full_name", "id": f"eq.{user_id}"})
        if not rows:
            raise HTTPException(401, "Profile not found")
        return rows[0]

    async def select(self, table, params):
        return (await self._request("GET", f"/rest/v1/{table}", params=params)).json()

    async def insert(self, table, row):
        response = await self._request("POST", f"/rest/v1/{table}", json=row,
                                       headers={"Prefer": "return=representation"})
        return response.json()[0]

    async def update(self, table, match, values):
        """PATCH rows matching {column: value}; returns the updated rows."""
        params = {column: f"eq.{value}" for column, value in match.items()}
        response = await self._request("PATCH", f"/rest/v1/{table}", params=params, json=values,
                                       headers={"Prefer": "return=representation"})
        return response.json()

    async def download(self, path):
        """Downloads a file from the private medical-reports bucket."""
        response = await self._request("GET", f"/storage/v1/object/authenticated/medical-reports/{quote(path)}")
        return response.content
