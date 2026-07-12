SUPPORTED_SITES = [
    {
        "platform": "youtube",
        "name": "YouTube",
        "scope": "내 댓글 기록",
        "mode": "자동 조회",
        "tier": "automatic",
        "accuracy": "높음",
        "note": "로그인된 댓글 기록 페이지에서 댓글 본문, 영상 제목, 원문 링크를 분리해 수집합니다.",
    },
    {
        "platform": "instagram",
        "name": "Instagram",
        "scope": "내 댓글",
        "mode": "자동 조회",
        "tier": "automatic",
        "accuracy": "부분",
        "note": "내 활동 → 반응 → 댓글 목록에서 본문이 확인된 내 댓글만 수집합니다.",
    },
    {
        "platform": "threads",
        "name": "Threads",
        "scope": "내 게시글·답글",
        "mode": "자동 조회",
        "tier": "automatic",
        "accuracy": "부분",
        "note": "로그인된 Threads 프로필의 게시글 탭과 답글 탭에서 본인 작성 항목만 수집합니다.",
    },
    {
        "platform": "facebook",
        "name": "Facebook",
        "scope": "내 게시글·댓글",
        "mode": "자동 조회",
        "tier": "automatic",
        "accuracy": "부분",
        "note": "활동 로그의 내 게시물과 댓글 범주를 각각 조회하며, 본인 작성이 확인된 항목만 저장합니다.",
    },
    {
        "platform": "x",
        "name": "X",
        "scope": "내 게시글·답글",
        "mode": "자동 조회",
        "tier": "automatic",
        "accuracy": "부분",
        "note": "로그인 계정의 프로필에서 본문만 수집하고 작성자명·핸들·날짜는 제외합니다.",
    },
    {
        "platform": "naver_blog",
        "name": "네이버 블로그",
        "scope": "내 블로그 게시글",
        "mode": "자동 조회",
        "tier": "automatic",
        "accuracy": "부분",
        "note": "로그인된 블로그 ID를 확인한 뒤 실제 게시글 링크와 제목만 수집합니다.",
    },
    {
        "platform": "naver_kin",
        "name": "네이버 지식iN",
        "scope": "내 질문·답변",
        "mode": "자동 조회",
        "tier": "automatic",
        "accuracy": "부분",
        "note": "지식iN MY 프로필의 질문 탭과 답변 탭에서 실제 Q&A 원문 링크만 수집합니다.",
    },
    {
        "platform": "generic",
        "name": "현재 페이지 가져오기",
        "scope": "화면에 로드된 게시글·댓글 후보",
        "mode": "수동 조회",
        "tier": "manual",
        "accuracy": "사이트별 차이",
        "note": "지원 목록에 없는 커뮤니티의 내가 쓴 글·댓글 목록 페이지를 직접 연 뒤 사용합니다.",
    },
]

PLATFORM_LABELS = {site["platform"]: site["name"] for site in SUPPORTED_SITES}
PLATFORM_LABELS.update({"naver": "네이버", "generic": "기타 사이트"})

ACTIVITY_TYPE_LABELS = {
    "comment": "댓글",
    "post": "게시글",
    "question": "질문",
    "answer": "답변",
    "question_or_answer": "질문·답변",
}

VISIBLE_ACTIVITY_TYPES = frozenset(ACTIVITY_TYPE_LABELS)
EXCLUDED_PLATFORMS = frozenset({
    "github", "google_my_activity", "stackoverflow", "reddit", "linkedin", "medium", "devto"
})

STATUS_LABELS = {
    "success": "완료",
    "partial": "일부 확인",
    "login_required": "로그인 필요",
    "error": "오류",
}
