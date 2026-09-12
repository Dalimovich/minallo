from app.services.request_generation import (
    clear_generations_for_tests,
    is_current_generation,
    register_generation,
)


def setup_function():
    clear_generations_for_tests()


def test_older_generation_cannot_become_current_again():
    register_generation("user", "conversation", 4)
    register_generation("user", "conversation", 3)
    assert is_current_generation("user", "conversation", 4)
    assert not is_current_generation("user", "conversation", 3)


def test_generations_are_isolated_by_user_and_conversation():
    register_generation("user-a", "conversation", 8)
    assert is_current_generation("user-b", "conversation", 1)
    assert is_current_generation("user-a", "other", 1)


def test_missing_generation_keeps_legacy_clients_working():
    assert is_current_generation("user", None, None)
