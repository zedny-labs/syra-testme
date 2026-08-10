# Per-Admin Learner Account Ownership — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `users` table a `created_by_id` owner so each admin/instructor only sees and can schedule the learner accounts they created — closing the gap where learner accounts are a shared pool surfaced only by exam interaction.

**Architecture:** Add a self-referential `created_by_id` FK to `User` (matching the pattern already used by exams, courses, question pools, categories, grading scales, user groups). Stamp it on create. Scope the **scheduling picker** strictly to the owner, and the **user-management list** to owner-or-interaction. Backfill existing learners via an Alembic migration (owner = creator of the earliest exam the learner attempted → scheduled → primary admin). Frontend points the session picker at the already-existing `learnersForScheduling` endpoint.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (Python), Alembic migrations, pytest (in-memory SQLite via `Base.metadata.create_all`), React + Vite frontend.

---

## Decisions — confirm before executing

**D1. Scheduling picker (`list_learners_for_scheduling`) = STRICT ownership.**
An admin can only assign learners where `created_by_id == current.id`. This is the isolation the user asked for.

**D2. User-management list (`list_users`) + `get_user` = OWNER **or** INTERACTION (union).**
An admin sees a learner if they created it **or** the learner has an attempt/schedule on one of that admin's exams. Rationale: preserves visibility of learners an admin already grades (and of backfilled learners owned by a different admin who nonetheless took this admin's exam). This is a superset of D1 — strictly less surprising than hiding learners mid-workflow.
→ *If you want the management list ALSO strict (owner-only), drop the interaction clauses in Task 4. Flagged for the user.*

**D3. `email` and `user_id` stay GLOBALLY unique.** They are login identifiers, so — unlike category/group names — we do **not** switch to per-owner uniqueness. No unique-constraint changes.

**D4. Only learner accounts get an owner in the backfill.** Admins/instructors are created by signup/seed and keep `created_by_id = NULL`. Newly created learners are stamped with the creating admin. (`created_by_id` is nullable for existing/self-created accounts.)

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `backend/src/app/models/__init__.py` | `User` model | Add `created_by_id` column + `creator` / `created_users` relationships |
| `backend/src/app/modules/users/service.py` | User CRUD + scoping | Stamp owner on create; scope picker (strict) + list/get (union) |
| `backend/src/app/modules/users/routes_admin.py` | Admin user routes | Pass `current` into `create_user` (remove `del current`) |
| `backend/alembic/versions/202607091000_scope_learners_per_owner.py` | Migration | Add column + backfill (NEW FILE) |
| `backend/scripts/seed_demo_data.py` | Demo seed | Stamp learners with owner |
| `backend/scripts/seed_mass_data.py` | Mass seed | Stamp learners with owner |
| `backend/scripts/prepare_single_exam_sandbox.py` | Sandbox seed | Stamp learners with owner |
| `backend/tests/test_admin_data_isolation.py` | Isolation regression tests | Add learner-ownership tests |
| `frontend/src/pages/Admin/AdminManageTestPage/AdminManageTestPage.jsx` | Session picker data source | Fetch `learnersForScheduling` instead of scoped `users` |

---

## Task 1: Add `created_by_id` to the `User` model

**Files:**
- Modify: `backend/src/app/models/__init__.py` (User class, ~line 76–104)

- [ ] **Step 1: Add the column + relationships to `User`.**

In the `User` class, after the `updated_at` column add:

```python
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
```

And in the relationships block of `User` add (self-referential, so specify the join side explicitly):

```python
    creator = relationship("User", remote_side="User.id", backref="created_users")
```

- [ ] **Step 2: Verify the model imports at the Python level.**

Run: `cd backend && PYTHONPATH=src python -c "from app.models import User; print('created_by_id' in User.__table__.columns)"`
Expected: `True`

- [ ] **Step 3: Commit.**

```bash
git add backend/src/app/models/__init__.py
git commit -m "feat(users): add created_by_id owner column to User model"
```

---

## Task 2: Stamp the creating admin on `create_user`

**Files:**
- Modify: `backend/src/app/modules/users/service.py` (`create_user`, ~line 176)
- Modify: `backend/src/app/modules/users/routes_admin.py` (`create_user`, ~line 58–65)
- Test: `backend/tests/test_admin_data_isolation.py`

- [ ] **Step 1: Write the failing test.** Append to `test_admin_data_isolation.py`:

```python
from app.modules.users.service import UserService
from app.modules.users.repository import UserRepository
from app.schemas import UserCreate


def _svc(db):
    return UserService(UserRepository(db))


def _make_learner(svc, admin, label):
    return svc.create_user(
        body=UserCreate(
            email=f"{label}-{uuid.uuid4().hex[:8]}@example.com",
            name=label,
            user_id=f"{label}-{uuid.uuid4().hex[:6]}",
            role=RoleEnum.LEARNER,
            is_active=True,
            password="Passw0rd!",
        ),
        current=admin,
    )


def test_create_user_stamps_owner():
    db = _new_session()
    admin_a = _admin(db, "adminA")
    learner = _make_learner(_svc(db), admin_a, "lrn")
    assert learner.created_by_id == admin_a.id
```

- [ ] **Step 2: Run it — expect failure.**

Run: `cd backend && PYTHONPATH=src pytest tests/test_admin_data_isolation.py::test_create_user_stamps_owner -v`
Expected: FAIL — `create_user() got an unexpected keyword argument 'current'`

- [ ] **Step 3: Update the service.** In `service.py`, change the signature and the `User(...)` construction:

```python
    def create_user(self, *, body: UserCreate, current: User | None = None) -> User:
        payload = self._normalize_user_payload(body.model_dump(exclude={"password"}), partial=False)
        self._ensure_unique_email(payload["email"])
        self._ensure_unique_user_id(payload["user_id"])
        now = datetime.now(timezone.utc)
        user = User(
            email=payload["email"],
            name=payload["name"],
            user_id=payload["user_id"],
            role=payload["role"],
            is_active=payload["is_active"],
            hashed_password=hash_password(body.password),
            created_by_id=current.id if current is not None else None,
            created_at=now,
            updated_at=now,
        )
```

- [ ] **Step 4: Update the route.** In `routes_admin.py` `create_user`, remove `del current` and pass it through:

```python
    return service.create_user(body=body, current=current)
```

- [ ] **Step 5: Run the test — expect pass.**

Run: `cd backend && PYTHONPATH=src pytest tests/test_admin_data_isolation.py::test_create_user_stamps_owner -v`
Expected: PASS

- [ ] **Step 6: Commit.**

```bash
git add backend/src/app/modules/users/service.py backend/src/app/modules/users/routes_admin.py backend/tests/test_admin_data_isolation.py
git commit -m "feat(users): stamp created_by_id when an admin creates a user"
```

---

## Task 3: Scope the scheduling picker strictly to the owner (D1)

**Files:**
- Modify: `backend/src/app/modules/users/service.py` (`list_learners_for_scheduling`, ~line 143–172)
- Test: `backend/tests/test_admin_data_isolation.py`

- [ ] **Step 1: Write the failing test.** Append:

```python
def test_scheduling_picker_is_owner_scoped(monkeypatch):
    import app.modules.users.service as usvc
    monkeypatch.setattr(usvc, "load_permission_rows", lambda db: [
        {"feature": "Assign Schedules", "ADMIN": True},
        {"feature": "Manage Users", "ADMIN": True},
    ])
    db = _new_session()
    admin_a = _admin(db, "adminA")
    admin_b = _admin(db, "adminB")
    svc = _svc(db)
    learner = _make_learner(svc, admin_a, "lrn")

    a_ids = {str(u.id) for u in svc.list_learners_for_scheduling(current=admin_a, search=None, is_active=None)}
    b_ids = {str(u.id) for u in svc.list_learners_for_scheduling(current=admin_b, search=None, is_active=None)}
    assert str(learner.id) in a_ids, "owner cannot see own learner in picker"
    assert str(learner.id) not in b_ids, "picker leaked another admin's learner"
```

- [ ] **Step 2: Run it — expect failure** (admin_b currently sees all learners).

Run: `cd backend && PYTHONPATH=src pytest tests/test_admin_data_isolation.py::test_scheduling_picker_is_owner_scoped -v`
Expected: FAIL — `learner.id` IS in `b_ids`.

- [ ] **Step 3: Add the owner filter.** In `list_learners_for_scheduling`, inside `_load_learners`, change the base query’s `.where(User.role == RoleEnum.LEARNER)` to also require ownership:

```python
            query = (
                select(User)
                .options(
                    load_only(
                        User.id, User.email, User.name, User.user_id,
                        User.role, User.is_active, User.created_at, User.updated_at,
                    )
                )
                .where(User.role == RoleEnum.LEARNER)
                .where(User.created_by_id == current.id)
            )
```

Also add `current.id` to the `cache_key` dict already built in this method (it currently keys on `user_id=str(getattr(current,"id",""))` — confirm that stays, so per-admin cache separation holds).

- [ ] **Step 4: Run the test — expect pass.**

Run: `cd backend && PYTHONPATH=src pytest tests/test_admin_data_isolation.py::test_scheduling_picker_is_owner_scoped -v`
Expected: PASS

- [ ] **Step 5: Commit.**

```bash
git add backend/src/app/modules/users/service.py backend/tests/test_admin_data_isolation.py
git commit -m "feat(users): scope scheduling picker to learners the admin created"
```

---

## Task 4: Scope the management list + get_user to owner-or-interaction (D2)

**Files:**
- Modify: `backend/src/app/modules/users/service.py` (`list_users` scoping ~line 76–88; `get_user` ~line 201–216)
- Test: `backend/tests/test_admin_data_isolation.py`

- [ ] **Step 1: Write the failing test.** Append:

```python
def test_management_list_and_get_user_owner_scoped():
    db = _new_session()
    admin_a = _admin(db, "adminA")
    admin_b = _admin(db, "adminB")
    svc = _svc(db)
    learner = _make_learner(svc, admin_a, "lrn")
    db.flush()

    from app.utils.pagination import PaginationParams
    pg = PaginationParams(page=1, page_size=50, search=None, sort="created_at", order="desc")

    a_items = svc.list_users(pagination=pg, role="LEARNER", is_active=None, actor_id=admin_a.id)["items"]
    b_items = svc.list_users(pagination=pg, role="LEARNER", is_active=None, actor_id=admin_b.id)["items"]
    assert any(str(i["id"]) == str(learner.id) for i in a_items), "owner cannot see own learner in list"
    assert not any(str(i["id"]) == str(learner.id) for i in b_items), "list leaked another admin's learner"

    with pytest.raises(HTTPException) as exc:
        svc.get_user(str(learner.id), actor_id=admin_b.id)
    assert exc.value.status_code == 404
```

- [ ] **Step 2: Run it — expect failure** (`list_users` currently only scopes by attempt/schedule, so a learner with neither is invisible to its own creator, and `get_user` allows only interaction).

Run: `cd backend && PYTHONPATH=src pytest tests/test_admin_data_isolation.py::test_management_list_and_get_user_owner_scoped -v`
Expected: FAIL — `a_items` does not contain the learner (no attempt/schedule yet).

- [ ] **Step 3: Add ownership to `list_users` scoping.** In `list_users`, extend the `or_(...)` block:

```python
            if actor_id:
                actor_exam_ids = select(Exam.id).where(Exam.created_by_id == actor_id)
                query = query.where(
                    or_(
                        User.id == actor_id,
                        User.created_by_id == actor_id,
                        User.id.in_(select(Attempt.user_id).where(Attempt.exam_id.in_(actor_exam_ids))),
                        User.id.in_(select(Schedule.user_id).where(Schedule.exam_id.in_(actor_exam_ids))),
                    )
                )
```

- [ ] **Step 4: Add ownership to `get_user`.** Replace the interaction-only check so ownership also grants access:

```python
    def get_user(self, user_id: str, *, actor_id=None) -> User:
        user = self.repository.get_user(parse_uuid_param(user_id, detail=_t("user_not_found")))
        if not user:
            raise HTTPException(status_code=404, detail=_t("user_not_found"))
        if actor_id and user.id != actor_id and user.created_by_id != actor_id:
            has_connection = self.repository.db.scalar(
                select(func.count(Attempt.id)).where(
                    Attempt.user_id == user.id,
                    Attempt.exam_id.in_(select(Exam.id).where(Exam.created_by_id == actor_id)),
                )
            )
            if not has_connection:
                raise HTTPException(status_code=404, detail=_t("user_not_found"))
        return user
```

- [ ] **Step 5: Run the test — expect pass.**

Run: `cd backend && PYTHONPATH=src pytest tests/test_admin_data_isolation.py::test_management_list_and_get_user_owner_scoped -v`
Expected: PASS

- [ ] **Step 6: Run the whole isolation file — expect all pass.**

Run: `cd backend && PYTHONPATH=src pytest tests/test_admin_data_isolation.py -v`
Expected: all PASS

- [ ] **Step 7: Commit.**

```bash
git add backend/src/app/modules/users/service.py backend/tests/test_admin_data_isolation.py
git commit -m "feat(users): scope user list + get_user by owner-or-interaction"
```

---

## Task 5: Alembic migration — add column + backfill

**Files:**
- Create: `backend/alembic/versions/202607091000_scope_learners_per_owner.py`

Model on `202607081200_isolate_category_grading_group_per_owner.py`. Current head is `202607081300` — verify with `cd backend && PYTHONPATH=src alembic heads` and set `down_revision` accordingly.

- [ ] **Step 1: Create the migration file** with this content:

```python
"""scope learner accounts to the admin that created them

Adds ``created_by_id`` to ``users`` (self-referential FK, SET NULL). Existing
learners are backfilled to the admin whose exam they most-earliest attempted,
then earliest scheduled, then the primary admin. Admins/instructors stay NULL.
No uniqueness changes (email/user_id remain globally unique login identifiers).

Revision ID: 202607091000
Revises: 202607081300
Create Date: 2026-07-09 10:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "202607091000"
down_revision = "202607081300"
branch_labels = None
depends_on = None


def _uuid_type(is_pg: bool):
    return postgresql.UUID(as_uuid=True) if is_pg else sa.String(length=36)


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    inspector = sa.inspect(bind)

    columns = {col["name"] for col in inspector.get_columns("users")}
    if "created_by_id" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "created_by_id",
                _uuid_type(is_pg),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )

    if not is_pg:
        # Tests/dev SQLite build the schema from the models (create_all); the
        # backfill below is a Postgres-only production concern.
        return

    # 1) Owner = creator of the earliest exam the learner ATTEMPTED.
    op.execute(
        """
        UPDATE users AS u
        SET created_by_id = e.created_by_id
        FROM (
            SELECT DISTINCT ON (a.user_id) a.user_id, ex.created_by_id
            FROM attempts a
            JOIN exams ex ON ex.id = a.exam_id
            WHERE ex.created_by_id IS NOT NULL
            ORDER BY a.user_id, ex.created_at
        ) AS e
        WHERE u.id = e.user_id
          AND u.created_by_id IS NULL
          AND CAST(u.role AS TEXT) = 'LEARNER'
        """
    )

    # 2) Still-unowned learners: creator of the earliest exam they were SCHEDULED to.
    op.execute(
        """
        UPDATE users AS u
        SET created_by_id = e.created_by_id
        FROM (
            SELECT DISTINCT ON (s.user_id) s.user_id, ex.created_by_id
            FROM schedules s
            JOIN exams ex ON ex.id = s.exam_id
            WHERE ex.created_by_id IS NOT NULL
            ORDER BY s.user_id, ex.created_at
        ) AS e
        WHERE u.id = e.user_id
          AND u.created_by_id IS NULL
          AND CAST(u.role AS TEXT) = 'LEARNER'
        """
    )

    # 3) Any remaining learner with no interaction -> primary admin.
    op.execute(
        """
        UPDATE users SET created_by_id = (
            SELECT id FROM users
            WHERE CAST(role AS TEXT) = 'ADMIN'
            ORDER BY created_at NULLS LAST, id
            LIMIT 1
        )
        WHERE created_by_id IS NULL
          AND CAST(role AS TEXT) = 'LEARNER'
        """
    )


def downgrade() -> None:
    op.drop_column("users", "created_by_id")
```

- [ ] **Step 2: Apply the migration locally against SQLite/dev to confirm it runs.**

Run: `cd backend && PYTHONPATH=src alembic upgrade head`
Expected: completes without error; `alembic current` shows `202607091000`.

- [ ] **Step 3: Confirm the model↔migration agree (autogenerate is empty).**

Run: `cd backend && PYTHONPATH=src alembic revision --autogenerate -m "verify" --sql 2>/dev/null | grep -i "add_column\|users" || echo "no diff"`
Expected: no pending `users.created_by_id` diff. (Delete any scratch revision this creates.)

- [ ] **Step 4: Commit.**

```bash
git add backend/alembic/versions/202607091000_scope_learners_per_owner.py
git commit -m "feat(users): migration to backfill learner ownership"
```

---

## Task 6: Stamp owner in seed scripts

**Files:**
- Modify: `backend/scripts/seed_demo_data.py` (learner1 ~line 44, learner2 ~line 48)
- Modify: `backend/scripts/seed_mass_data.py` (student1 ~line 116, student2 ~line 124, and any loop that bulk-creates learners)
- Modify: `backend/scripts/prepare_single_exam_sandbox.py` (any `User(... role=RoleEnum.LEARNER ...)`)

- [ ] **Step 1: In each script, set `created_by_id` on every learner `User(...)` to the seed's owning admin/instructor.** These scripts flush the admin/instructor before learners, so its `.id` is available. Example (seed_demo_data.py):

```python
        learner1 = User(
            ...,
            role=RoleEnum.LEARNER, hashed_password=hash_password("Student1234!"),
            created_by_id=instructor.id,
        )
        learner2 = User(
            ...,
            role=RoleEnum.LEARNER, hashed_password=hash_password("Student1234!"),
            created_by_id=instructor.id,
        )
```

For `seed_mass_data.py`, if learners are created in a loop, set `created_by_id=<the admin/instructor created earlier in that scope>.id` on each. Ensure the owner is flushed (has an `id`) before the learners are constructed.

- [ ] **Step 2: Run a seed against a scratch DB and verify learners are owned.**

Run: `cd backend && PYTHONPATH=src python scripts/seed_demo_data.py` (against a disposable DB), then query:
`PYTHONPATH=src python -c "from app.db.session import SessionLocal; from app.models import User, RoleEnum; from sqlalchemy import select; db=SessionLocal(); print([ (u.name,u.created_by_id is not None) for u in db.scalars(select(User).where(User.role==RoleEnum.LEARNER)) ])"`
Expected: every learner shows `True`.

- [ ] **Step 3: Commit.**

```bash
git add backend/scripts/seed_demo_data.py backend/scripts/seed_mass_data.py backend/scripts/prepare_single_exam_sandbox.py
git commit -m "feat(seed): stamp created_by_id on seeded learner accounts"
```

---

## Task 7: Frontend — point the session picker at the owner-scoped endpoint

**Files:**
- Modify: `frontend/src/pages/Admin/AdminManageTestPage/AdminManageTestPage.jsx` (data loader, ~line 1177)

Today the SessionsTab learner dropdown is fed by `adminApi.users({ role: 'LEARNER' })` (the management list). Switch it to `adminApi.learnersForScheduling` — which after Task 3 returns only the admin's own learners and (unlike `users`) returns a **plain array**, not a paginated envelope.

- [ ] **Step 1: Change the fetch.** Replace the `needsUsers` task:

```javascript
      if (needsUsers) tasks.push(['users', adminApi.learnersForScheduling({ is_active: true })])
```

- [ ] **Step 2: Handle the non-paginated shape.** Where the loader does
`const resolvedUsers = payloads.users != null ? readPaginatedItems(payloads.users) : usersRef.current`,
make it tolerate a plain array (learnersForScheduling returns `UserRead[]` directly):

```javascript
      const resolvedUsers = payloads.users != null
        ? (Array.isArray(payloads.users) ? payloads.users : readPaginatedItems(payloads.users))
        : usersRef.current
```

- [ ] **Step 3: Build to confirm.**

Run: `cd frontend && npm run build`
Expected: `✓ built` with no errors.

- [ ] **Step 4: Commit.**

```bash
git add frontend/src/pages/Admin/AdminManageTestPage/AdminManageTestPage.jsx
git commit -m "feat(sessions): source the learner picker from owner-scoped endpoint"
```

---

## Task 8: Full regression + ship

- [ ] **Step 1: Run the backend test suite.**

Run: `cd backend && PYTHONPATH=src pytest tests/ -q`
Expected: no new failures vs. baseline (note: some suites may be pre-existing red — compare to a clean checkout if unsure).

- [ ] **Step 2: Frontend lint + build.**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Push to `dev` and verify the deploy is green** (dev auto-deploys on push to `dev` on the `zedny-labs` remote), then smoke-test on `dev-varexam.zedny.ai`: as admin A create a learner → it appears in A's schedule picker; log in as admin B → that learner is absent from B's picker and users list.

---

## Self-Review notes

- **Spec coverage:** D1 → Task 3; D2 → Task 4; D3 → no constraint change (confirmed in Task 5); D4 → Tasks 2, 5, 6. Model → Task 1. Backfill → Task 5. Frontend (Part A of "A+B") → Task 7.
- **Migration safety:** column is nullable, `SET NULL` on owner delete (never cascades away a learner). Backfill is idempotent (`WHERE created_by_id IS NULL`). Guarded Postgres-only, matching the existing `202607081200` pattern; SQLite tests use `create_all`.
- **Open risk to confirm with user:** D2 keeps interaction-visibility in the management list. If strict-only is wanted there, remove the two `.in_(...Attempt/Schedule...)` clauses in Task 4 Step 3 and the `has_connection` fallback in Step 4.
