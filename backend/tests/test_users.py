async def _search(client, user, query=None):
    params = {"search": query} if query is not None else {}
    r = await client.get("/api/v1/users", params=params, headers=user.headers)
    assert r.status_code == 200
    return r.json()["data"]


async def test_search_never_returns_emails(client, make_user):
    me, other = await make_user("finder"), await make_user("findme")
    results = await _search(client, me, other.username[:6])
    assert any(u["id"] == other.id for u in results)
    assert all("email" not in u for u in results)


async def test_chats_never_show_other_peoples_emails(client, make_user, add_message):
    # Starting a chat with someone, or reading their messages, mustn't reveal their email either
    me, other = await make_user(), await make_user()
    r = await client.post("/api/v1/conversations", json={"kind": "dm", "participant_ids": [other.id]}, headers=me.headers)
    assert r.status_code == 200
    assert other.email not in r.text
    dm = r.json()["data"]["id"]
    await add_message(dm, other, "hi")
    r = await client.get(f"/api/v1/conversations/{dm}/messages", headers=me.headers)
    assert r.status_code == 200 and r.json()["data"]
    assert other.email not in r.text


async def test_search_needs_two_characters(client, make_user):
    me = await make_user()
    assert await _search(client, me, "f") == []


async def test_email_matches_only_exactly(client, make_user):
    me, other = await make_user(), await make_user()
    assert [u["id"] for u in await _search(client, me, other.email)] == [other.id]
    domain = "@" + other.email.split("@")[1]
    assert await _search(client, me, domain) == []


async def test_like_wildcards_are_literal(client, make_user):
    me = await make_user()
    assert await _search(client, me, "%%") == []
    assert await _search(client, me, "__") == []


async def test_without_search_only_contacts(client, make_user, make_dm):
    me, friend, stranger = await make_user(), await make_user(), await make_user()
    await make_dm(me, friend)
    ids = {u["id"] for u in await _search(client, me)}
    assert friend.id in ids
    assert stranger.id not in ids


async def test_profile_username_rules_and_readable_errors(client, make_user):
    me, other = await make_user(), await make_user()
    r = await client.patch("/api/v1/auth/me", json={"username": "Bad Name!"}, headers=me.headers)
    assert r.status_code == 422 and "lowercase letters" in r.json()["message"]
    r = await client.patch("/api/v1/auth/me", json={"username": other.username}, headers=me.headers)
    assert r.status_code == 409 and r.json()["message"] == "Username is already taken"
    r = await client.patch("/api/v1/auth/me", json={"username": "New.Name_1", "bio": "Hi"}, headers=me.headers)
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["username"] == "new.name_1" and data["bio"] == "Hi" and data["email_verified"] is True
