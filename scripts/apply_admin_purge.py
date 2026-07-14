from pathlib import Path

MAIN_PATH = Path("app/main.py")
TEMPLATE_PATH = Path("app/templates/admin_dashboard.html")

ROUTE_BLOCK = '''\n\n@app.post("/admin/data/purge")\ndef admin_purge_all_collected_data(\n    request: Request,\n    password: str = Form(...),\n    confirmation: str = Form(...),\n    csrf: str = Form(...),\n    db: Session = Depends(get_db),\n):\n    require_csrf(request, csrf)\n    admin = require_web_admin(request, db)\n    if isinstance(admin, RedirectResponse):\n        return admin\n\n    if confirmation.strip() != "전체삭제":\n        return RedirectResponse("/admin?purge_error=confirmation", status_code=303)\n    if not verify_password(password, admin.password_hash):\n        return RedirectResponse("/admin?purge_error=password", status_code=303)\n\n    activity_count = db.scalar(select(func.count(Activity.id))) or 0\n    scan_count = db.scalar(select(func.count(ScanLog.id))) or 0\n\n    db.execute(delete(ScanLog))\n    db.execute(delete(Activity))\n    db.commit()\n\n    return RedirectResponse(\n        f"/admin?purge_ok=1&deleted_activities={activity_count}&deleted_scans={scan_count}",\n        status_code=303,\n    )\n'''

UI_BLOCK = '''\n<section class="card danger-zone">\n  <div class="section-head"><div><p class="card-kicker">데이터 초기화</p><h2>전체 수집 데이터 삭제</h2></div></div>\n  <p class="muted">모든 사용자의 수집 활동과 조회 실행 기록을 영구 삭제합니다. 사용자 계정, 이메일, 비밀번호와 관리자 권한은 유지됩니다.</p>\n  {% if request.query_params.get('purge_ok') == '1' %}\n    <div class="alert success">삭제 완료: 수집 활동 {{ request.query_params.get('deleted_activities', '0') }}건, 조회 기록 {{ request.query_params.get('deleted_scans', '0') }}건</div>\n  {% elif request.query_params.get('purge_error') == 'confirmation' %}\n    <div class="alert error">확인란에 전체삭제를 정확히 입력하세요.</div>\n  {% elif request.query_params.get('purge_error') == 'password' %}\n    <div class="alert error">관리자 비밀번호가 올바르지 않습니다.</div>\n  {% endif %}\n  <form method="post" action="/admin/data/purge" class="stack-form" onsubmit="return confirm('모든 사용자의 수집 활동과 조회 기록을 영구 삭제합니다. 계속하시겠습니까?');">\n    <input type="hidden" name="csrf" value="{{ csrf_token }}">\n    <label>관리자 비밀번호<input type="password" name="password" autocomplete="current-password" required></label>\n    <label>확인을 위해 <b>전체삭제</b> 입력<input type="text" name="confirmation" autocomplete="off" required></label>\n    <button class="button danger full" type="submit">전체 수집 데이터 영구 삭제</button>\n  </form>\n</section>\n'''


def replace_once(text: str, anchor: str, replacement: str, label: str) -> str:
    count = text.count(anchor)
    if count != 1:
        raise RuntimeError(f"{label} 기준 문자열 개수가 {count}개입니다. 파일 구조를 확인하세요.")
    return text.replace(anchor, replacement, 1)


def main() -> None:
    main_text = MAIN_PATH.read_text(encoding="utf-8")
    template_text = TEMPLATE_PATH.read_text(encoding="utf-8")

    if '@app.post("/admin/data/purge")' not in main_text:
        main_anchor = '\n\n@app.get("/privacy", response_class=HTMLResponse)'
        main_text = replace_once(main_text, main_anchor, ROUTE_BLOCK + main_anchor, "main.py")
        MAIN_PATH.write_text(main_text, encoding="utf-8")
        print("[OK] app/main.py 수정")
    else:
        print("[SKIP] app/main.py 이미 적용됨")

    if "전체 수집 데이터 삭제" not in template_text:
        template_anchor = '</section>\n<section class="admin-grid">'
        template_text = replace_once(
            template_text,
            template_anchor,
            '</section>' + UI_BLOCK + '<section class="admin-grid">',
            "admin_dashboard.html",
        )
        TEMPLATE_PATH.write_text(template_text, encoding="utf-8")
        print("[OK] app/templates/admin_dashboard.html 수정")
    else:
        print("[SKIP] 관리자 삭제 UI 이미 적용됨")


if __name__ == "__main__":
    main()
