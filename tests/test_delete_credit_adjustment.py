from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADJUSTMENT = ROOT / "app" / "delete_credit_adjustment.py"
TEMPLATE = ROOT / "app" / "templates" / "admin_delete_credits.html"
MIDDLEWARE = ROOT / "app" / "redis_session.py"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_admin_adjustment_accepts_negative_amounts_safely() -> None:
    source = read(ADJUSTMENT)
    compile(source, str(ADJUSTMENT), "exec")

    assert '@router.post("/admin/delete-credits/grant")' in source
    assert "amount == 0 or abs(amount) > MAX_ADMIN_CREDIT_ADJUSTMENT" in source
    assert "adjusted = current_balance + amount" in source
    assert "if adjusted < 0" in source
    assert 'raise ValueError("insufficient-balance")' in source
    assert ".with_for_update()" in source
    assert 'reason="관리자 발급" if is_grant else "관리자 회수"' in source
    assert 'result_key = "granted" if is_grant else "recovered"' in source


def test_admin_form_explains_and_confirms_credit_recovery() -> None:
    template = read(TEMPLATE)

    assert 'action="/admin/delete-credits/grant"' in template
    assert 'min="-100000"' in template
    assert 'max="100000"' in template
    assert 'class="quick-amounts positive"' in template
    assert 'class="quick-amounts negative"' in template
    assert template.index('class="quick-amounts positive"') < template.index('class="quick-amounts negative"')
    assert 'data-amount="-10"' in template
    assert 'data-amount="-50"' in template
    assert 'data-amount="-100"' in template
    assert "현재 보유 수량보다 많은 삭제권은 회수할 수 없습니다." in template
    assert "삭제권 ${Math.abs(amount)}개를 회수하시겠습니까?" in template
    assert "{{ '+' if entry.amount > 0 else '' }}{{ entry.amount }}개" in template


def test_adjustment_route_uses_existing_dispatched_admin_path() -> None:
    middleware = read(MIDDLEWARE)

    assert "from app.delete_credit_adjustment import router as delete_credit_adjustment_router" in middleware
    assert middleware.index("account_tools_app.include_router(delete_credit_adjustment_router)") < middleware.index("account_tools_app.include_router(delete_credits_router)")
    assert '"/admin/delete-credits/grant"' in middleware
    assert '"/admin/delete-credits/adjust"' not in middleware
