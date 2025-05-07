"""
format_line_logs_fixed.py
生 LINE CSV  →  質問 / 回答 / やりとり 形式の Markdown

必須列: sendTime,userId,roomId,sender,text
sender は 'user' or 'agent'
"""

import pandas as pd  # type: ignore
from datetime import timedelta
from pathlib import Path

# ───── パラメータ ─────
SRC     = "LINE_logs.csv"        # 入力 CSV
DST     = "formatted_output.md"  # 出力 Markdown
GAP_MIN = 15                     # 同じ user で 15 分空けば新しい親質問
# ────────────────────

# ① 読み込み & ソート
df = pd.read_csv(SRC, parse_dates=["sendTime"])
df = df.sort_values(["roomId", "sendTime"]).reset_index(drop=True)

# ② 親質問（new_ticket）判定
gap = timedelta(minutes=GAP_MIN)

# 前行との差
prev_time   = df["sendTime"].shift()
prev_room   = df["roomId"].shift()
prev_sender = df["sender"].shift()

df["new_ticket"] = (
    (df["sender"] == "user") &                              # ユーザー発話で
    (                                                      # かつ次のどれか
       (prev_time.isna()) |                                # 1) 最初の行
       (prev_room != df["roomId"]) |                       # 2) ルームが変わる
       ((df["sendTime"] - prev_time) > gap)                # 3) 15 分以上空く
    )
)

# roomId ごとに連番
df["ticket_id"] = df.groupby("roomId")["new_ticket"].cumsum()

# ③ 連続ロールを 1 ブロックに結合
df["block_id"] = (
    (df["sender"] != prev_sender) |
    (df["ticket_id"] != df["ticket_id"].shift()) |
    (df["roomId"]   != prev_room)
).cumsum()

blocks = (
    df.groupby("block_id")
      .agg(
          roomId     =("roomId", "first"),
          ticket_id  =("ticket_id", "first"),
          role       =("sender", "first"),
          text       =("text", lambda x: "\n".join(x))
      )
      .reset_index(drop=True)
)

# ④ テンプレート整形
sections = []
parent_counter = 1

for (room, tid), grp in blocks.groupby(["roomId", "ticket_id"]):
    grp = grp.reset_index(drop=True)
    if len(grp) < 2:
        continue                # 最低でも質問+回答が無いとスキップ

    sec = [
        f"質問{parent_counter}: {grp.loc[0,'text']}",
        f"回答: {grp.loc[1,'text']}"
    ]

    for idx in range(2, len(grp)):
        sec.append(f"やりとり{idx-1}: {grp.loc[idx,'text']}")

    sections.append("\n".join(sec))
    parent_counter += 1

Path(DST).write_text("\n\n".join(sections), encoding="utf-8")
print(f"✅ フォーマット完了 → {DST}")
