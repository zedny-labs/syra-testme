def test_admin_can_create_user(client, admin_headers):
    response = client.post(
        "/api/users/",
        headers=admin_headers,
        json={
            "email": "created.user@example.com",
            "name": "Created User",
            "user_id": "USR100",
            "role": "LEARNER",
            "password": "Password123!",
            "is_active": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == "created.user@example.com"
    assert body["role"] == "LEARNER"


def test_admin_can_list_users_with_pagination(client, admin_headers, admin_user, learner_user, link_learner_to_admin):
    response = client.get(
        "/api/users/?search=learner@example.com&skip=0&limit=10",
        headers=admin_headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["skip"] == 0
    assert body["limit"] == 10
    assert body["items"][0]["email"] == learner_user.email


def test_admin_can_patch_user(client, admin_headers, learner_user, link_learner_to_admin):
    response = client.patch(
        f"/api/users/{learner_user.id}",
        headers=admin_headers,
        json={
            "name": "Updated Learner",
            "email": "updated.learner@example.com",
            "role": "INSTRUCTOR",
            "is_active": False,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Updated Learner"
    assert body["email"] == "updated.learner@example.com"
    assert body["role"] == "INSTRUCTOR"
    assert body["is_active"] is False


def test_learner_cannot_create_user(client, learner_headers):
    response = client.post(
        "/api/users/",
        headers=learner_headers,
        json={
            "email": "blocked.user@example.com",
            "name": "Blocked User",
            "user_id": "USR101",
            "role": "LEARNER",
            "password": "Password123!",
            "is_active": True,
        },
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Insufficient permissions"}
