from src.app.models import RoleEnum, User


def test_login_success_returns_tokens(client, learner_user):
    response = client.post(
        "/api/auth/login",
        json={"email": learner_user.email, "password": "Password123!"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["refresh_token"]


def test_login_invalid_password_returns_401(client, learner_user):
    response = client.post(
        "/api/auth/login",
        json={"email": learner_user.email, "password": "WrongPassword123!"},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid credentials"}


def test_signup_forbidden_when_disabled(client):
    response = client.post(
        "/api/auth/signup",
        json={
            "email": "new.user@example.com",
            "name": "New User",
            "user_id": "LRN777",
            "password": "Password123!",
        },
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Self sign-up disabled"}


def test_signup_success_when_enabled(client, db, enable_signup):
    response = client.post(
        "/api/auth/signup",
        json={
            "email": "new.user@example.com",
            "name": "New User",
            "user_id": "LRN777",
            "password": "Password123!",
        },
    )

    assert response.status_code == 200
    assert response.json()["detail"].startswith("Signup successful")

    created = db.query(User).filter(User.email == "new.user@example.com").one()
    assert created.name == "New User"
    assert created.user_id == "LRN777"


def test_me_returns_authenticated_user(client, learner_headers, learner_user):
    response = client.get("/api/auth/me", headers=learner_headers)

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == learner_user.email
    assert body["role"] == learner_user.role.value


def test_logout_returns_ok(client, learner_headers):
    response = client.post("/api/auth/logout", headers=learner_headers)

    assert response.status_code == 200
    assert response.json() == {"detail": "Logged out"}


def test_reactivating_user_does_not_restore_previous_tokens(client, admin_headers, learner_user, link_learner_to_admin):
    login_response = client.post(
        "/api/auth/login",
        json={"email": learner_user.email, "password": "Password123!"},
    )
    assert login_response.status_code == 200
    tokens = login_response.json()
    stale_headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    deactivate_response = client.patch(
        f"/api/users/{learner_user.id}",
        json={"is_active": False},
        headers=admin_headers,
    )
    assert deactivate_response.status_code == 200

    reactivate_response = client.patch(
        f"/api/users/{learner_user.id}",
        json={"is_active": True},
        headers=admin_headers,
    )
    assert reactivate_response.status_code == 200

    me_response = client.get("/api/auth/me", headers=stale_headers)
    assert me_response.status_code == 401
    assert me_response.json() == {"detail": "Invalid token"}

    refresh_response = client.post(
        "/api/auth/refresh",
        json={"refresh_token": tokens["refresh_token"]},
    )
    assert refresh_response.status_code == 401
    assert refresh_response.json() == {"detail": "Invalid token"}


def test_role_change_invalidates_existing_tokens(client, admin_headers, learner_user, link_learner_to_admin):
    login_response = client.post(
        "/api/auth/login",
        json={"email": learner_user.email, "password": "Password123!"},
    )
    assert login_response.status_code == 200
    tokens = login_response.json()
    stale_headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    role_change_response = client.patch(
        f"/api/users/{learner_user.id}",
        json={"role": RoleEnum.INSTRUCTOR.value},
        headers=admin_headers,
    )
    assert role_change_response.status_code == 200
    assert role_change_response.json()["role"] == RoleEnum.INSTRUCTOR.value

    me_response = client.get("/api/auth/me", headers=stale_headers)
    assert me_response.status_code == 401
    assert me_response.json() == {"detail": "Invalid token"}

    refresh_response = client.post(
        "/api/auth/refresh",
        json={"refresh_token": tokens["refresh_token"]},
    )
    assert refresh_response.status_code == 401
    assert refresh_response.json() == {"detail": "Invalid token"}
