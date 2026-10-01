"""Identify Naver posts without treating help and neighbor links as owned posts."""
import re
from urllib.parse import parse_qs, urlsplit


def post_blog_id(source_url: str | None) -> str | None:
    try:
        url = urlsplit(source_url or "")
        if url.scheme != "https" or url.netloc != "blog.naver.com":
            return None
        pretty = re.fullmatch(r"/([A-Za-z0-9_-]{2,50})/(\d+)/?", url.path)
        if pretty:
            return pretty[1].lower()
        if url.path.lower() != "/postview.naver":
            return None
        query = parse_qs(url.query)
        blogs, posts = query.get("blogId", []), query.get("logNo", [])
        if (len(blogs) == len(posts) == 1 and re.fullmatch(r"[A-Za-z0-9_-]{2,50}", blogs[0])
                and re.fullmatch(r"\d+", posts[0])):
            return blogs[0].lower()
    except (TypeError, ValueError):
        pass
    return None


def is_own_blog_post(source_url: str | None, account_label: str | None) -> bool:
    return bool(account_label and post_blog_id(source_url) == account_label.lower())
