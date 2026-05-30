"""
YouTube Uploader Module
Handles authentication and video upload to YouTube using the YouTube Data API.
Falls back to youtube-upload CLI tool if available.
"""

import sys
import json
import os
import subprocess
import pickle
from pathlib import Path

try:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
    GOOGLE_API_AVAILABLE = True
except ImportError:
    GOOGLE_API_AVAILABLE = False

# If modifying these scopes, delete the file token.pickle.
SCOPES = ['https://www.googleapis.com/auth/youtube.upload']
TOKEN_DIR = os.path.join(os.path.dirname(__file__), "..", "config")
CLIENT_SECRETS_FILE = os.path.join(TOKEN_DIR, "client_secret.json")
TOKEN_FILE = os.path.join(TOKEN_DIR, "token.pickle")


def get_authenticated_service():
    """Authenticate and return YouTube API service."""
    creds = None
    
    # Token file stores the user's access and refresh tokens
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, 'rb') as token:
            creds = pickle.load(token)
    
    # If there are no (valid) credentials available, let the user log in
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CLIENT_SECRETS_FILE):
                return None, "Client secrets file not found. Create one at: " + CLIENT_SECRETS_FILE
            
            flow = InstalledAppFlow.from_client_secrets_file(
                CLIENT_SECRETS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
        
        # Save the credentials for the next run
        os.makedirs(TOKEN_DIR, exist_ok=True)
        with open(TOKEN_FILE, 'wb') as token:
            pickle.dump(creds, token)
    
    service = build('youtube', 'v3', credentials=creds)
    return service, None


def upload_video(
    video_path: str,
    title: str,
    description: str = "",
    tags: list = None,
    category_id: str = "22",  # 22 = People & Blogs
    privacy_status: str = "unlisted",
    publish_at: str = None,
    thumbnail_path: str = None
) -> dict:
    """Upload a video to YouTube.
    
    Args:
        video_path: Path to video file
        title: Video title
        description: Video description
        tags: List of tags
        category_id: YouTube category ID
        privacy_status: public, private, or unlisted
        publish_at: ISO 8601 datetime for scheduled publishing
        thumbnail_path: Path to thumbnail image
    
    Returns:
        dict with upload result
    """
    if not os.path.exists(video_path):
        return {
            "success": False,
            "error": f"Video file not found: {video_path}",
            "fallback": True
        }
    
    # Try youtube-upload CLI first (if installed)
    cli_result = _upload_with_youtube_upload_cli(
        video_path, title, description, tags, privacy_status
    )
    if cli_result.get("success"):
        return cli_result
    
    # Try Google API
    if GOOGLE_API_AVAILABLE:
        api_result = _upload_with_api(
            video_path, title, description, tags, category_id,
            privacy_status, publish_at, thumbnail_path
        )
        if api_result.get("success"):
            return api_result
    
    # Return fallback response
    return {
        "success": False,
        "error": "No upload method available. Install youtube-upload CLI or configure Google API credentials.",
        "video_path": video_path,
        "title": title,
        "privacy_status": privacy_status,
        "fallback": True,
        "instructions": """
To upload manually:
1. Install youtube-upload CLI: pip install youtube-uploader
2. Or configure Google API OAuth credentials at https://console.cloud.google.com/
3. Save client_secret.json to config/client_secret.json
"""
    }


def _upload_with_youtube_upload_cli(
    video_path: str, title: str, description: str,
    tags: list, privacy_status: str
) -> dict:
    """Try uploading using youtube-upload CLI tool."""
    try:
        cmd = [
            "youtube-upload",
            "--title", title,
            "--description", description or "",
            "--privacy", privacy_status,
        ]
        
        if tags:
            for tag in tags:
                cmd.extend(["--tags", tag])
        
        cmd.append(video_path)
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        
        if result.returncode == 0:
            video_id = result.stdout.strip()
            return {
                "success": True,
                "video_id": video_id,
                "url": f"https://youtu.be/{video_id}",
                "method": "youtube-upload-cli",
                "title": title,
                "privacy_status": privacy_status
            }
        else:
            return {"success": False, "error": result.stderr}
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        return {"success": False, "error": str(e)}


def _upload_with_api(
    video_path: str, title: str, description: str,
    tags: list, category_id: str, privacy_status: str,
    publish_at: str, thumbnail_path: str
) -> dict:
    """Upload using Google YouTube Data API v3."""
    try:
        service, error = get_authenticated_service()
        if error:
            return {"success": False, "error": error}
        
        body = {
            'snippet': {
                'title': title,
                'description': description or "",
                'tags': tags or [],
                'categoryId': category_id
            },
            'status': {
                'privacyStatus': privacy_status
            }
        }
        
        if publish_at:
            body['status']['publishAt'] = publish_at
        
        media = MediaFileUpload(video_path, chunksize=-1, resumable=True)
        
        request = service.videos().insert(
            part=','.join(body.keys()),
            body=body,
            media_body=media
        )
        
        response = None
        while response is None:
            status, response = request.next_chunk()
            if status:
                print(f"Upload progress: {int(status.progress() * 100)}%", file=sys.stderr)
        
        video_id = response.get('id')
        
        # Upload thumbnail if provided
        if thumbnail_path and os.path.exists(thumbnail_path):
            try:
                service.thumbnails().set(
                    videoId=video_id,
                    media_body=MediaFileUpload(thumbnail_path)
                ).execute()
            except Exception as e:
                print(f"Thumbnail upload error: {e}", file=sys.stderr)
        
        return {
            "success": True,
            "video_id": video_id,
            "url": f"https://youtu.be/{video_id}",
            "method": "google-api",
            "title": title,
            "privacy_status": privacy_status
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def check_upload_status(video_id: str) -> dict:
    """Check the status of an uploaded video."""
    try:
        service, error = get_authenticated_service()
        if error:
            return {"success": False, "error": error}
        
        request = service.videos().list(
            part="status,snippet,statistics",
            id=video_id
        )
        response = request.execute()
        
        if response.get('items'):
            video = response['items'][0]
            return {
                "success": True,
                "title": video['snippet']['title'],
                "views": video['statistics'].get('viewCount', 0),
                "likes": video['statistics'].get('likeCount', 0),
                "comments": video['statistics'].get('commentCount', 0),
                "privacy_status": video['status']['privacyStatus']
            }
        return {"success": False, "error": "Video not found"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def check_setup_status() -> dict:
    """Check if upload tools are properly configured."""
    cli_available = False
    api_available = False
    
    try:
        subprocess.run(["youtube-upload", "--version"], capture_output=True, check=True)
        cli_available = True
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    
    if os.path.exists(CLIENT_SECRETS_FILE):
        api_available = True
    
    return {
        "cli_tool_available": cli_available,
        "google_api_configured": api_available,
        "token_exists": os.path.exists(TOKEN_FILE),
        "ready": cli_available or api_available
    }


if __name__ == "__main__":
    input_data = json.loads(sys.stdin.read())
    action = input_data.get("action", "upload")
    
    if action == "check_setup":
        result = check_setup_status()
    elif action == "check_status":
        result = check_upload_status(input_data.get("video_id", ""))
    else:
        result = upload_video(
            video_path=input_data.get("video_path", ""),
            title=input_data.get("title", "My YouTube Video"),
            description=input_data.get("description", ""),
            tags=input_data.get("tags", []),
            category_id=input_data.get("category_id", "22"),
            privacy_status=input_data.get("privacy_status", "unlisted"),
            publish_at=input_data.get("publish_at"),
            thumbnail_path=input_data.get("thumbnail_path")
        )
    
    print(json.dumps(result, indent=2))
