"""The AI service records patient access through the database function.

These cover the part of audit logging that lives in this service: that an
access event goes to log_patient_access() with a whitelisted action and
without a client-chosen timestamp or actor, and that a failure to record
never hides the clinical result.

The database side (who may call the function, and what the patient is
allowed to read back) is enforced in supabase_migration_v8.sql and needs a
Postgres instance to exercise.
"""
import asyncio
import unittest

from fastapi import HTTPException

import server

# Every action name log_patient_access() accepts, copied from migration v8.
ALLOWED_ACTIONS = {
    "opened_patient_record", "viewed_patient", "viewed_document",
    "downloaded_document", "uploaded_report", "deleted_report",
    "generated_history_pdf", "ran_ai_analysis", "updated_record",
}


class FakeSupa:
    """Records the calls the service makes, and can fail like PostgREST."""

    def __init__(self, fail=False):
        self.rpc_calls = []
        self.inserts = []
        self.fail = fail

    async def rpc(self, name, args):
        if self.fail:
            raise HTTPException(403, "Not authorized to access this patient record.")
        self.rpc_calls.append((name, args))
        return None

    async def insert(self, table, row):
        self.inserts.append((table, row))
        return row


USER = {"id": "11111111-1111-4111-8111-111111111111", "role": "doctor", "full_name": "Test Doctor"}
PATIENT = "22222222-2222-4222-8222-222222222222"


def run(coroutine):
    return asyncio.run(coroutine)


class AuditTests(unittest.TestCase):
    def test_every_service_action_maps_to_an_allowed_event(self):
        for action, event in server.ACCESS_EVENTS.items():
            with self.subTest(action=action):
                self.assertIn(event, ALLOWED_ACTIONS)

    def test_audit_goes_through_the_database_function(self):
        supa = FakeSupa()
        run(server.audit(supa, USER, "history_pdf_export", PATIENT, {"visits": 3}))

        self.assertEqual(supa.inserts, [], "audit_logs must not be written directly")
        self.assertEqual(len(supa.rpc_calls), 1)
        name, args = supa.rpc_calls[0]
        self.assertEqual(name, "log_patient_access")
        self.assertEqual(args["p_patient_id"], PATIENT)
        self.assertEqual(args["p_action"], "generated_history_pdf")
        self.assertEqual(args["p_metadata"]["event"], "history_pdf_export")
        self.assertEqual(args["p_metadata"]["visits"], 3)

    def test_the_caller_cannot_choose_the_actor_or_the_timestamp(self):
        supa = FakeSupa()
        run(server.audit(supa, USER, "ai_summary", PATIENT, {"model": "synthetic"}))

        _, args = supa.rpc_calls[0]
        self.assertEqual(set(args), {"p_patient_id", "p_action", "p_metadata"})
        for forbidden in ("user_id", "created_at", "timestamp", "accessed_at"):
            self.assertNotIn(forbidden, args)
            self.assertNotIn(forbidden, args["p_metadata"])

    def test_an_unknown_action_still_records_a_whitelisted_event(self):
        supa = FakeSupa()
        run(server.audit(supa, USER, "something_new", PATIENT, None))

        _, args = supa.rpc_calls[0]
        self.assertIn(args["p_action"], ALLOWED_ACTIONS)
        self.assertEqual(args["p_metadata"], {"event": "something_new"})

    def test_a_refused_log_does_not_raise(self):
        supa = FakeSupa(fail=True)
        # The clinical result has already been produced; a rejected audit
        # write must not turn it into an error for the caller.
        run(server.audit(supa, USER, "ai_ecg_analysis", PATIENT, {"status": "ok"}))

    def test_nothing_is_logged_without_a_patient(self):
        supa = FakeSupa()
        run(server.audit(supa, USER, "ai_summary", None, {}))
        self.assertEqual(supa.rpc_calls, [])


if __name__ == "__main__":
    unittest.main()
