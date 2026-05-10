# 部署说明

这个项目需要 Node 后端，所以不能只用 GitHub Pages。

推荐方式：

1. 在 GitHub 新建一个私有仓库。
2. 把当前目录推到仓库。
3. 在 Render 连接这个 GitHub 仓库，并使用仓库里的 `render.yaml` 创建服务。
4. 设置环境变量：
   - `FAMILY_PASSWORD`：家庭访问密码
   - `SESSION_SECRET`：一段随机长字符串（Render 蓝图会自动生成）
   - `HOST=0.0.0.0`
5. 部署完成后，用 Render 给出的 `https://...onrender.com` 链接发给家人。

如果你想用命令行推到 GitHub：

```bash
git init
git add .
git commit -m "Initial family stock check app"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/YOUR_REPO.git
git push -u origin main
```

注意：

- GitHub Pages 只能托管静态网页，不能运行这里的密码校验、实时行情接口和定时刷新逻辑。
- 公网部署后请使用强密码，不要使用默认演示密码 `123456`。
- 当前行情价格来自腾讯证券行情接口，并用新浪财经行情交叉校验；公告、财报、监管、解禁、行业变量未接入权威源时，页面会显示待同步并暂不下结论。
