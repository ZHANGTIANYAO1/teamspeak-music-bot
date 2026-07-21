<template>
  <div class="settings-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      返回
    </button>
    <h1 class="page-title">设置</h1>

    <!-- Theme Toggle -->
    <section class="settings-section">
      <h2 class="section-title">外观</h2>
      <div class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:theme-light-dark" class="setting-icon" />
          主题模式
        </div>
        <button class="theme-toggle" @click="store.toggleTheme()">
          <Icon :icon="store.theme === 'dark' ? 'mdi:weather-night' : 'mdi:weather-sunny'" />
          {{ store.theme === 'dark' ? '深色' : '浅色' }}
        </button>
      </div>
    </section>

    <!-- Account: own password change -->
    <section class="settings-section">
      <h2 class="section-title">账户</h2>
      <div class="account-info-card">
        <div class="account-row">
          <span class="account-label">用户名</span>
          <span class="account-value">{{ session.currentUser.value?.username ?? '—' }}</span>
        </div>
        <div class="account-row">
          <span class="account-label">角色</span>
          <span class="account-value">
            <span class="user-role-badge" :class="`role-${session.currentUser.value?.role}`">
              {{ session.currentUser.value?.role === 'admin' ? '管理员' : '成员' }}
            </span>
          </span>
        </div>
      </div>
      <form class="change-pw-form" @submit.prevent="onChangeOwnPassword">
        <input v-model="ownPw.old" type="password" autocomplete="current-password" class="input" placeholder="当前密码" required />
        <input v-model="ownPw.new" type="password" autocomplete="new-password" minlength="8" class="input" placeholder="新密码 (≥8 位)" required />
        <input v-model="ownPw.confirm" type="password" autocomplete="new-password" minlength="8" class="input" placeholder="再次输入新密码" required />
        <button class="btn-sm btn-primary" type="submit" :disabled="changingOwnPw">
          {{ changingOwnPw ? '更新中…' : '修改密码' }}
        </button>
      </form>
      <p v-if="ownPwError" class="user-error">{{ ownPwError }}</p>
      <p v-if="ownPwSuccess" class="user-success">{{ ownPwSuccess }}</p>
    </section>

    <!-- Bot Management (create/edit/delete/start-stop) requires bot.manage -->
    <section v-if="can('bot.manage')" class="settings-section">
      <h2 class="section-title">机器人管理</h2>
      <div class="bot-list">
        <div v-for="bot in store.bots" :key="bot.id" class="bot-item">
          <div class="bot-info">
            <div class="bot-name">{{ bot.name }}</div>
            <div class="bot-status" :class="botStatusClass(bot)">
              {{ botStatusText(bot) }}
            </div>
          </div>
          <div class="bot-actions">
            <button class="btn-sm" @click="toggleBot(bot.id, bot.connected)">
              {{ bot.connected ? '停止' : '启动' }}
            </button>
            <button class="btn-sm btn-edit" @click="openEditBot(bot)">
              <Icon icon="mdi:pencil" />
            </button>
            <button class="btn-sm btn-delete" @click="deleteBot(bot.id, bot.name)">
              <Icon icon="mdi:delete" />
            </button>
          </div>
        </div>
      </div>

      <!-- Edit Bot Modal -->
      <div v-if="editingBot" class="edit-modal-overlay" @click.self="editingBot = null">
        <div class="edit-modal">
          <h3 class="modal-title">编辑机器人</h3>
          <div class="form-group">
            <label>名称</label>
            <input v-model="editForm.name" class="input" />
          </div>
          <div class="form-group">
            <label>服务器地址</label>
            <input v-model="editForm.serverAddress" class="input" placeholder="ts.example.com" />
          </div>
          <div class="form-row">
            <div class="form-group" style="flex:1">
              <label>端口</label>
              <input v-model.number="editForm.serverPort" type="number" class="input" />
            </div>
            <div class="form-group" style="flex:2">
              <label>昵称</label>
              <input v-model="editForm.nickname" class="input" />
            </div>
          </div>
          <div class="form-group">
            <label>默认频道名称（可选）</label>
            <input v-model="editForm.defaultChannel" :disabled="!!editForm.channelId" class="input" :class="{ disabled: !!editForm.channelId }" placeholder="音乐频道" />
          </div>
          <div class="form-group">
            <label>默认频道ID（可选）</label>
            <input v-model="editForm.channelId" :disabled="!!editForm.defaultChannel" class="input" :class="{ disabled: !!editForm.defaultChannel }" placeholder="如 12" />
          </div>
          <div class="form-group">
            <label>频道密码（可选）</label>
            <input v-model="editForm.channelPassword" class="input" type="password" />
          </div>
          <div class="form-group">
            <label>服务器密码（可选）</label>
            <input v-model="editForm.serverPassword" class="input" type="password" placeholder="服务器有密码时填写" />
          </div>
          <div class="form-group">
            <label>自定义头像</label>
            <CustomAvatarRow :bot-id="editingBot" />
          </div>
          <div class="modal-actions">
            <button class="btn-secondary" @click="editingBot = null">取消</button>
            <button class="btn-primary" @click="saveEditBot">保存（需重启机器人生效）</button>
          </div>
        </div>
      </div>

      <!-- Create Bot -->
      <div class="create-bot">
        <h3 class="subsection-title">创建新实例</h3>
        <div class="form-group">
          <label>名称</label>
          <input v-model="newBotName" class="input" placeholder="我的音乐机器人" />
        </div>
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>服务器地址</label>
            <input v-model="newBotServer" class="input" placeholder="localhost 或 ts.example.com" />
          </div>
          <div class="form-group" style="flex:1">
            <label>端口</label>
            <input v-model.number="newBotPort" type="number" class="input" placeholder="9987" />
          </div>
        </div>
        <div class="form-group">
          <label>昵称</label>
          <input v-model="newBotNickname" class="input" placeholder="MusicBot" />
        </div>
        <div class="form-group">
          <label>默认频道名称（可选）</label>
          <input v-model="newBotChannel" :disabled="!!newBotChannelId" class="input" :class="{ disabled: !!newBotChannelId }" placeholder="音乐频道" />
        </div>
        <div class="form-group">
          <label>默认频道ID（可选）</label>
          <input v-model="newBotChannelId" :disabled="!!newBotChannel" class="input" :class="{ disabled: !!newBotChannel }" placeholder="如 12" />
        </div>
        <div class="form-group">
          <label>服务器密码（可选）</label>
          <input v-model="newBotServerPassword" class="input" type="password" placeholder="服务器有密码时填写" />
        </div>
        <div class="form-group">
          <label>自定义头像（可选）</label>
          <AvatarUpload v-model="newBotAvatar" />
        </div>
        <button class="btn-primary" @click="createBot">创建</button>
      </div>
    </section>

    <!-- Jellyfin — optional self-hosted music source. Admin-configured
         connection (server URL + credentials), no QR flow. The card stays
         visible even while the source is disabled: the enable toggle below is
         the only UI that flips its enabledProviders membership, so hiding the
         card would leave no way to turn Jellyfin on. -->
    <section v-if="can('platform.auth')" class="settings-section">
      <h2 class="section-title">Jellyfin 音乐库（可选）</h2>

      <div class="account-card">
        <div class="account-header">
          <Icon icon="mdi:jellyfish" class="account-icon jellyfin-icon" />
          <div class="account-info">
            <div class="account-name">Jellyfin</div>
            <div class="account-status" :class="{ logged: jellyfinAuth.loggedIn }">
              {{ jellyfinAuth.loggedIn ? `已连接: ${jellyfinAuth.nickname}` : '未连接' }}
            </div>
          </div>
        </div>

        <!-- Enable (opt-in source: presence in enabledProviders) -->
        <label class="profile-toggle behavior-toggle spotify-toggle">
          <div class="profile-toggle-text">
            <div class="profile-toggle-label">启用 Jellyfin 音源</div>
            <div class="profile-toggle-hint">开启后 Jellyfin 出现在搜索、首页与聊天命令（!play -j）的音源列表中。默认关闭，点击下方「保存」后生效。</div>
          </div>
          <input v-model="jellyfinEnabledForm" type="checkbox" class="profile-toggle-switch" />
        </label>

        <div class="form-group">
          <label>服务器地址</label>
          <input v-model="jellyfinForm.serverUrl" class="input" autocomplete="off" placeholder="https://jellyfin.example.com" />
        </div>

        <div class="setting-row spotify-row">
          <div class="setting-label">认证方式</div>
          <div class="spotify-btn-group">
            <button
              class="spotify-choice"
              :class="{ active: jellyfinForm.authMode === 'userpass' }"
              @click="jellyfinForm.authMode = 'userpass'"
            >账号密码</button>
            <button
              class="spotify-choice"
              :class="{ active: jellyfinForm.authMode === 'apikey' }"
              @click="jellyfinForm.authMode = 'apikey'"
            >API Key</button>
          </div>
        </div>

        <template v-if="jellyfinForm.authMode === 'userpass'">
          <div class="form-group">
            <label>用户名</label>
            <input v-model="jellyfinForm.username" class="input" autocomplete="off" placeholder="Jellyfin 用户名" />
          </div>
          <div class="form-group">
            <label>
              密码
              <span class="spotify-secret-hint" :class="{ set: jellyfinHasPassword }">
                {{ jellyfinHasPassword ? '已设置' : '未设置' }}
              </span>
            </label>
            <input
              v-model="jellyfinForm.password"
              class="input"
              type="password"
              autocomplete="off"
              placeholder="留空表示不修改已保存的密码"
            />
          </div>
        </template>
        <template v-else>
          <div class="form-group">
            <label>
              API Key
              <span class="spotify-secret-hint" :class="{ set: jellyfinHasApiKey }">
                {{ jellyfinHasApiKey ? '已设置' : '未设置' }}
              </span>
            </label>
            <input
              v-model="jellyfinForm.apiKey"
              class="input"
              type="password"
              autocomplete="off"
              placeholder="留空表示不修改已保存的 API Key"
            />
          </div>
          <div class="form-group">
            <label>用户 ID</label>
            <input v-model="jellyfinForm.userId" class="input" autocomplete="off" placeholder="该 Key 对应使用的 Jellyfin 用户 ID" />
          </div>
        </template>

        <div class="spotify-actions">
          <button class="btn-secondary" :disabled="jellyfinTesting" @click="testJellyfin">
            {{ jellyfinTesting ? '测试中…' : '测试连接' }}
          </button>
          <button class="btn-primary" :disabled="jellyfinSaving" @click="saveJellyfin">
            {{ jellyfinSaving ? '保存中…' : '保存' }}
          </button>
        </div>

        <p v-if="jellyfinMessage" class="spotify-message" :class="`tone-${jellyfinMessageTone}`">{{ jellyfinMessage }}</p>
      </div>
    </section>

    <!-- Music Account - QR Code Login (platform auth) requires platform.auth.
         Cards for sources disabled via enabledProviders are hidden. -->
    <section v-if="can('platform.auth') && (providerOn('netease') || providerOn('qq') || providerOn('bilibili') || providerOn('kugou'))" class="settings-section">
      <h2 class="section-title">音乐账号</h2>

      <!-- NetEase -->
      <div v-if="providerOn('netease')" class="account-card">
        <div class="account-header">
          <Icon icon="mdi:cloud-outline" class="account-icon" />
          <div class="account-info">
            <div class="account-name">网易云音乐</div>
            <div class="account-status" :class="{ logged: neteaseAuth.loggedIn }">
              {{ neteaseAuth.loggedIn ? `已登录: ${neteaseAuth.nickname}` : '未登录' }}
            </div>
          </div>
        </div>

        <div class="login-methods">
          <button
            class="login-btn"
            :class="{ active: neteaseLoginMode === 'qr' }"
            @click="startQrLogin('netease')"
            :disabled="neteaseQr.loading"
          >
            <Icon icon="mdi:qrcode" />
            扫码登录
          </button>
          <button
            class="login-btn"
            :class="{ active: neteaseLoginMode === 'cookie' }"
            @click="neteaseLoginMode = 'cookie'"
          >
            <Icon icon="mdi:cookie" />
            Cookie登录
          </button>
        </div>

        <!-- QR Code -->
        <div v-if="neteaseLoginMode === 'qr'" class="qr-section">
          <div v-if="neteaseQr.loading" class="qr-loading">
            <Icon icon="mdi:loading" class="spin" />
            生成二维码中...
          </div>
          <div v-else-if="neteaseQr.dataUrl" class="qr-wrap">
            <img :src="neteaseQr.dataUrl" class="qr-image" alt="QR Code" />
            <div class="qr-status" :class="neteaseQr.status">
              <template v-if="neteaseQr.status === 'waiting'">
                <Icon icon="mdi:cellphone" /> 请使用网易云音乐APP扫码
              </template>
              <template v-else-if="neteaseQr.status === 'scanned'">
                <Icon icon="mdi:check" /> 已扫码，请在手机上确认
              </template>
              <template v-else-if="neteaseQr.status === 'confirmed'">
                <Icon icon="mdi:check-circle" /> 登录成功!
              </template>
              <template v-else-if="neteaseQr.status === 'expired'">
                <Icon icon="mdi:refresh" /> 二维码已过期
                <button class="btn-link" @click="startQrLogin('netease')">重新生成</button>
              </template>
            </div>
          </div>
        </div>

        <!-- Cookie -->
        <div v-if="neteaseLoginMode === 'cookie'" class="cookie-section">
          <textarea
            v-model="neteaseCookie"
            class="textarea"
            placeholder="粘贴网易云音乐Cookie..."
            rows="3"
          />
          <button class="btn-primary btn-save" @click="saveCookie('netease')">保存Cookie</button>
        </div>
      </div>

      <!-- QQ Music -->
      <div v-if="providerOn('qq')" class="account-card">
        <div class="account-header">
          <Icon icon="mdi:music-circle-outline" class="account-icon" />
          <div class="account-info">
            <div class="account-name">QQ音乐</div>
            <div class="account-status" :class="{ logged: qqAuth.loggedIn }">
              {{ qqAuth.loggedIn ? `已登录: ${qqAuth.nickname}` : '未登录' }}
            </div>
          </div>
        </div>

        <div class="login-methods">
          <button
            class="login-btn"
            :class="{ active: qqLoginMode === 'qr' }"
            @click="startQrLogin('qq')"
            :disabled="qqQr.loading"
          >
            <Icon icon="mdi:qrcode" />
            扫码登录
          </button>
          <button
            class="login-btn"
            :class="{ active: qqLoginMode === 'cookie' }"
            @click="qqLoginMode = 'cookie'"
          >
            <Icon icon="mdi:cookie" />
            Cookie登录
          </button>
        </div>

        <!-- QR Code -->
        <div v-if="qqLoginMode === 'qr'" class="qr-section">
          <div v-if="qqQr.loading" class="qr-loading">
            <Icon icon="mdi:loading" class="spin" />
            生成二维码中...
          </div>
          <div v-else-if="qqQr.dataUrl" class="qr-wrap">
            <img :src="qqQr.dataUrl" class="qr-image" alt="QR Code" />
            <div class="qr-status" :class="qqQr.status">
              <template v-if="qqQr.status === 'waiting'">
                <Icon icon="mdi:cellphone" /> 请使用QQ音乐APP扫码
              </template>
              <template v-else-if="qqQr.status === 'scanned'">
                <Icon icon="mdi:check" /> 已扫码，请在手机上确认
              </template>
              <template v-else-if="qqQr.status === 'confirmed'">
                <Icon icon="mdi:check-circle" /> 登录成功!
              </template>
              <template v-else-if="qqQr.status === 'expired'">
                <Icon icon="mdi:refresh" /> 二维码已过期
                <button class="btn-link" @click="startQrLogin('qq')">重新生成</button>
              </template>
            </div>
          </div>
        </div>

        <!-- Cookie -->
        <div v-if="qqLoginMode === 'cookie'" class="cookie-section">
          <textarea
            v-model="qqCookie"
            class="textarea"
            placeholder="粘贴QQ音乐Cookie..."
            rows="3"
          />
          <button class="btn-primary btn-save" @click="saveCookie('qq')">保存Cookie</button>
        </div>
      </div>
      <!-- BiliBili -->
      <div v-if="providerOn('bilibili')" class="account-card">
        <div class="account-header">
          <Icon icon="mdi:video-outline" class="account-icon bilibili-icon" />
          <div class="account-info">
            <div class="account-name">哔哩哔哩</div>
            <div class="account-status" :class="{ logged: bilibiliAuth.loggedIn }">
              {{ bilibiliAuth.loggedIn ? `已登录: ${bilibiliAuth.nickname}` : '未登录' }}
            </div>
          </div>
        </div>

        <div class="login-methods">
          <button
            class="login-btn"
            :class="{ active: bilibiliLoginMode === 'qr' }"
            @click="startQrLogin('bilibili')"
            :disabled="bilibiliQr.loading"
          >
            <Icon icon="mdi:qrcode" />
            扫码登录
          </button>
          <button
            class="login-btn"
            :class="{ active: bilibiliLoginMode === 'cookie' }"
            @click="bilibiliLoginMode = 'cookie'"
          >
            <Icon icon="mdi:cookie" />
            Cookie登录
          </button>
        </div>

        <!-- QR Code -->
        <div v-if="bilibiliLoginMode === 'qr'" class="qr-section">
          <div v-if="bilibiliQr.loading" class="qr-loading">
            <Icon icon="mdi:loading" class="spin" />
            生成二维码中...
          </div>
          <div v-else-if="bilibiliQr.dataUrl" class="qr-wrap">
            <img :src="bilibiliQr.dataUrl" class="qr-image" alt="QR Code" />
            <div class="qr-status" :class="bilibiliQr.status">
              <template v-if="bilibiliQr.status === 'waiting'">
                <Icon icon="mdi:cellphone" /> 请使用哔哩哔哩APP扫码
              </template>
              <template v-else-if="bilibiliQr.status === 'scanned'">
                <Icon icon="mdi:check" /> 已扫码，请在手机上确认
              </template>
              <template v-else-if="bilibiliQr.status === 'confirmed'">
                <Icon icon="mdi:check-circle" /> 登录成功!
              </template>
              <template v-else-if="bilibiliQr.status === 'expired'">
                <Icon icon="mdi:refresh" /> 二维码已过期
                <button class="btn-link" @click="startQrLogin('bilibili')">重新生成</button>
              </template>
            </div>
          </div>
        </div>

        <!-- Cookie -->
        <div v-if="bilibiliLoginMode === 'cookie'" class="cookie-section">
          <textarea
            v-model="bilibiliCookie"
            class="textarea"
            placeholder="粘贴哔哩哔哩Cookie..."
            rows="3"
          />
          <button class="btn-primary btn-save" @click="saveCookie('bilibili')">保存Cookie</button>
        </div>
      </div>

      <!-- Kugou -->
      <div v-if="providerOn('kugou')" class="account-card">
        <div class="account-header">
          <Icon icon="mdi:music-circle-outline" class="account-icon kugou-icon" />
          <div class="account-info">
            <div class="account-name">酷狗音乐</div>
            <div class="account-status" :class="{ logged: kugouAuth.loggedIn }">
              {{ kugouAuth.loggedIn ? `已登录: ${kugouAuth.nickname}` : '未登录' }}
            </div>
          </div>
        </div>

        <div class="login-methods">
          <button
            class="login-btn"
            :class="{ active: kugouLoginMode === 'qr' }"
            @click="startQrLogin('kugou')"
            :disabled="kugouQr.loading"
          >
            <Icon icon="mdi:qrcode" />
            扫码登录
          </button>
          <button
            class="login-btn"
            :class="{ active: kugouLoginMode === 'cookie' }"
            @click="kugouLoginMode = 'cookie'"
          >
            <Icon icon="mdi:cookie" />
            Cookie登录
          </button>
        </div>

        <!-- QR Code -->
        <div v-if="kugouLoginMode === 'qr'" class="qr-section">
          <div v-if="kugouQr.loading" class="qr-loading">
            <Icon icon="mdi:loading" class="spin" />
            生成二维码中...
          </div>
          <div v-else-if="kugouQr.dataUrl" class="qr-wrap">
            <img :src="kugouQr.dataUrl" class="qr-image" alt="QR Code" />
            <div class="qr-status" :class="kugouQr.status">
              <template v-if="kugouQr.status === 'waiting'">
                <Icon icon="mdi:cellphone" /> 请使用酷狗音乐APP扫码
              </template>
              <template v-else-if="kugouQr.status === 'scanned'">
                <Icon icon="mdi:check" /> 已扫码，请在手机上确认
              </template>
              <template v-else-if="kugouQr.status === 'confirmed'">
                <Icon icon="mdi:check-circle" /> 登录成功!
              </template>
              <template v-else-if="kugouQr.status === 'expired'">
                <Icon icon="mdi:refresh" /> 二维码已过期
                <button class="btn-link" @click="startQrLogin('kugou')">重新生成</button>
              </template>
            </div>
          </div>
        </div>

        <!-- Cookie -->
        <div v-if="kugouLoginMode === 'cookie'" class="cookie-section">
          <textarea
            v-model="kugouCookie"
            class="textarea"
            placeholder="粘贴酷狗Cookie (token=...; userid=...)..."
            rows="3"
          />
          <button class="btn-primary btn-save" @click="saveCookie('kugou')">保存Cookie</button>
        </div>
      </div>
    </section>

    <!-- Default music source (issue #126): the source used by chat commands
         (!play/!add …) and the WebUI when no platform flag is given. Saving is a
         global bot setting, so gate on bot.manage like the other behavior rows. -->
    <section v-if="can('bot.manage')" class="settings-section">
      <h2 class="section-title">默认音源</h2>
      <p class="profile-section-hint">
        设置不带音源参数时（如聊天里的 <code>!play 歌名</code> 或网页搜索）默认使用的音源。
        例如把默认音源设为「哔哩哔哩」后，点播 B 站音乐就不用每次都加 <code>-b</code>。
        选择「自动」则按内置优先级挑选第一个已启用的音源（网易云 → QQ → 酷狗 → Jellyfin → 哔哩哔哩 → YouTube）。
      </p>
      <div class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:music-box-multiple-outline" class="setting-icon" />
          默认音源
        </div>
        <div class="prefix-input-wrap">
          <select v-model="defaultPlatformForm" class="input input-sm default-source-select">
            <option value="">自动（按优先级）</option>
            <option v-for="opt in defaultSourceOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <button class="btn-primary" :disabled="defaultSourceSaving" @click="saveDefaultSource">
            {{ defaultSourceSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
      <p v-if="defaultSourceMessage" class="spotify-message" :class="`tone-${defaultSourceMessageTone}`">{{ defaultSourceMessage }}</p>
    </section>

    <!-- Spotify (Connect) playback via librespot — requires platform.auth -->
    <section v-if="can('platform.auth')" class="settings-section">
      <h2 class="section-title">Spotify 播放（实验性）</h2>
      <p class="spotify-disclaimer">{{ SPOTIFY_DISCLAIMER }}</p>

      <div class="account-card">
        <div class="account-header">
          <Icon icon="mdi:spotify" class="account-icon spotify-icon" />
          <div class="account-info">
            <div class="account-name">Spotify (librespot)</div>
            <div class="account-status" :class="`tone-${spotifyStatusSummary.tone}`">
              {{ spotifyStatusSummary.label }}
            </div>
          </div>
        </div>

        <!-- Enable -->
        <label class="profile-toggle behavior-toggle spotify-toggle">
          <div class="profile-toggle-text">
            <div class="profile-toggle-label">启用 Spotify 播放</div>
            <div class="profile-toggle-hint">开启后可通过 librespot 后端播放 Spotify（需 Premium 账号 + 你自己注册的开发者应用凭据）。默认关闭。</div>
          </div>
          <input v-model="spotifyForm.enabled" type="checkbox" class="profile-toggle-switch" />
        </label>

        <!-- Backend -->
        <div class="setting-row spotify-row">
          <div class="setting-label">播放后端</div>
          <div class="spotify-btn-group">
            <button
              v-for="b in SPOTIFY_BACKENDS"
              :key="b.value"
              class="spotify-choice"
              :class="{ active: spotifyForm.backend === b.value }"
              @click="spotifyForm.backend = b.value"
            >
              {{ b.label }}
            </button>
          </div>
        </div>

        <!-- Bitrate -->
        <div class="setting-row spotify-row">
          <div class="setting-label">比特率 (kbps)</div>
          <div class="spotify-btn-group">
            <button
              v-for="rate in SPOTIFY_BITRATES"
              :key="rate"
              class="spotify-choice"
              :class="{ active: spotifyForm.bitrate === rate }"
              @click="spotifyForm.bitrate = rate"
            >
              {{ rate }}
            </button>
          </div>
        </div>

        <!-- Client ID -->
        <div class="form-group">
          <label>Client ID</label>
          <input v-model="spotifyForm.clientId" class="input" autocomplete="off" placeholder="Spotify 开发者应用 Client ID" />
        </div>

        <!-- Client Secret (write-only) -->
        <div class="form-group">
          <label>
            Client Secret
            <span class="spotify-secret-hint" :class="{ set: spotifyHasSecret }">
              {{ spotifyHasSecret ? '已设置' : '未设置' }}
            </span>
          </label>
          <input
            v-model="spotifyForm.clientSecret"
            class="input"
            type="password"
            autocomplete="off"
            placeholder="留空表示不修改已保存的 Secret"
          />
        </div>

        <!-- Device name -->
        <div class="form-group">
          <label>设备名称</label>
          <input v-model="spotifyForm.deviceName" class="input" autocomplete="off" placeholder="TSMusicBot" />
        </div>

        <div class="spotify-actions">
          <button class="btn-primary" :disabled="spotifySaving" @click="saveSpotify">
            {{ spotifySaving ? '保存中…' : '保存' }}
          </button>
          <button class="btn-secondary spotify-connect" :disabled="spotifyConnecting" @click="connectSpotify">
            <Icon icon="mdi:spotify" />
            {{ spotifyConnecting ? '跳转中…' : '连接 Spotify' }}
          </button>
        </div>

        <p v-if="spotifyMessage" class="spotify-message" :class="`tone-${spotifyMessageTone}`">{{ spotifyMessage }}</p>
      </div>
    </section>

    <!-- Audio Quality requires quality -->
    <section v-if="can('quality')" class="settings-section">
      <h2 class="section-title">音质设置</h2>
      <div v-if="providerOn('jellyfin')" class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:jellyfish" class="setting-icon" />
          Jellyfin 音质
        </div>
        <div class="quality-options">
          <button
            v-for="q in jellyfinQualityLevels"
            :key="q.value"
            class="quality-btn"
            :class="{ active: jellyfinQuality === q.value }"
            @click="setJellyfinQuality(q.value)"
          >
            <div class="quality-name">{{ q.label }}</div>
            <div class="quality-desc">{{ q.desc }}</div>
          </button>
        </div>
      </div>
      <div v-if="providerOn('netease') || providerOn('qq') || providerOn('kugou') || providerOn('bilibili')" class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:music-note-eighth" class="setting-icon" />
          音源质量
        </div>
        <div class="quality-options">
          <button
            v-for="q in qualityLevels"
            :key="q.value"
            class="quality-btn"
            :class="{ active: currentQuality === q.value }"
            @click="setQuality(q.value)"
          >
            <div class="quality-name">{{ q.label }}</div>
            <div class="quality-desc">{{ q.desc }}</div>
          </button>
        </div>
      </div>
    </section>

    <!-- Command Prefix -->
    <section class="settings-section">
      <h2 class="section-title">命令设置</h2>
      <div class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:console" class="setting-icon" />
          命令前缀
        </div>
        <div class="prefix-input-wrap">
          <input v-model="commandPrefix" class="input input-sm" placeholder="!" />
          <button class="btn-primary" @click="savePrefix">保存</button>
        </div>
      </div>
    </section>

    <!-- Idle Timeout -->
    <section v-if="can('bot.manage')" class="settings-section">
      <h2 class="section-title">行为设置</h2>
      <div class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:timer-off-outline" class="setting-icon" />
          <div>
            <div>闲置自动退出</div>
            <div style="font-size:12px; opacity:0.6; margin-top:2px">服务器上没有其他人时，机器人自动断开的等待时间（0 = 不退出）</div>
          </div>
        </div>
        <div class="prefix-input-wrap">
          <input
            v-model.number="idleTimeout"
            type="number"
            min="0"
            class="input input-sm"
            style="max-width:80px"
            placeholder="0"
          />
          <span style="font-size:13px; opacity:0.7">分钟</span>
          <button class="btn-primary" @click="saveIdleTimeout">保存</button>
        </div>
      </div>
      <label class="profile-toggle behavior-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">无人时自动暂停播放</div>
          <div class="profile-toggle-hint">服务器上只剩机器人自己时自动暂停，有人连接后自动继续播放（受协议限制，占用判断以整个服务器为准，无法精确到单个频道）</div>
        </div>
        <input
          v-model="autoPauseOnEmpty"
          type="checkbox"
          class="profile-toggle-switch"
          @change="saveAutoPause"
        />
      </label>

      <label class="profile-toggle behavior-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">语音闪避</div>
          <div class="profile-toggle-hint">检测到其他客户端说话时自动压低音乐音量，说话结束后恢复。默认关闭。</div>
        </div>
        <input
          v-model="voiceDuckingEnabled"
          type="checkbox"
          class="profile-toggle-switch"
          :disabled="voiceDuckingControlsDisabled"
          @change="saveVoiceDucking"
        />
      </label>

      <div class="setting-row voice-ducking-volume">
        <div class="setting-label">
          <Icon icon="mdi:volume-minus" class="setting-icon" />
          <div>
            <div>说话时保留原音量</div>
            <div class="voice-ducking-hint">例如设为 30%，有人说话时音乐将降至原音量的 30%。</div>
          </div>
        </div>
        <div class="voice-ducking-controls">
          <input
            v-model.number="voiceDuckingVolumePercent"
            type="range"
            min="0"
            max="100"
            step="0.1"
            class="voice-ducking-range"
            :disabled="voiceDuckingControlsDisabled"
            aria-label="说话时保留原音量百分比"
          />
          <div class="prefix-input-wrap">
            <input
              v-model.number="voiceDuckingVolumePercent"
              type="number"
              min="0"
              max="100"
              step="0.1"
              class="input input-sm"
              style="max-width:80px"
              :disabled="voiceDuckingControlsDisabled"
              aria-label="说话时保留原音量百分比"
              @blur="normalizeVoiceDuckingVolume"
            />
            <span class="voice-ducking-unit">%</span>
            <button class="btn-primary" :disabled="voiceDuckingControlsDisabled" @click="saveVoiceDucking">
              {{ !voiceDuckingLoaded ? '加载设置…' : voiceDuckingSaving ? '保存中…' : '保存比例' }}
            </button>
          </div>
        </div>
        <p
          v-if="voiceDuckingMessage"
          class="voice-ducking-message"
          :class="`tone-${voiceDuckingMessageTone}`"
          :role="voiceDuckingMessageTone === 'warn' ? 'alert' : 'status'"
          :aria-live="voiceDuckingMessageTone === 'warn' ? 'assertive' : 'polite'"
          aria-atomic="true"
        >
          {{ voiceDuckingMessage }}
        </p>
      </div>

      <label class="profile-toggle behavior-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">本地音频播放</div>
          <div class="profile-toggle-hint">开启后允许在搜索页拖拽/选择本地音频上传并播放；关闭后会拒绝新的本地上传和本地歌曲播放请求。</div>
        </div>
        <input
          v-model="localAudioEnabled"
          type="checkbox"
          class="profile-toggle-switch"
          @change="saveLocalAudioEnabled"
        />
      </label>

      <label class="profile-toggle behavior-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">保存/加载播放清单（含重启后自动恢复队列）</div>
          <div class="profile-toggle-hint">开启后可在网页与聊天命令（!save / !load / !queues）保存和加载播放清单，并在机器人重启后自动恢复并继续播放上次的队列。重启只能从当前曲目的开头恢复（不记忆进度）；Spotify 恢复为尽力而为。默认关闭。</div>
        </div>
        <input
          v-model="savedQueuesEnabled"
          type="checkbox"
          class="profile-toggle-switch"
          @change="saveSavedQueuesEnabled"
        />
      </label>

      <label class="profile-toggle behavior-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">直接播放单曲时不清空队列</div>
          <div class="profile-toggle-hint">开启后，直接播放单曲会插入到当前歌曲之后并立即播放，播完继续原队列，而不是清空整个队列。仅影响单曲的「直接播放」；歌单/专辑/电台仍会替换队列。默认关闭。</div>
        </div>
        <input
          v-model="playKeepsQueue"
          type="checkbox"
          class="profile-toggle-switch"
          @change="savePlayKeepsQueue"
        />
      </label>
    </section>

    <!-- Guest Mode (admin only) -->
    <section v-if="session.isAdmin.value" class="settings-section">
      <h2 class="section-title">游客模式</h2>
      <p class="profile-section-hint">开启后，访客无需登录即可进入并点歌（默认关闭）。游客永远无法查看或修改设置。下面逐项决定游客可用的能力。</p>

      <label class="profile-toggle behavior-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">允许游客访问</div>
          <div class="profile-toggle-hint">登录页会出现「以游客身份进入」。关闭后所有游客会话立即失效。</div>
        </div>
        <input v-model="guestMode.enabled" type="checkbox" class="profile-toggle-switch" />
      </label>

      <div v-if="guestMode.enabled" class="perm-group">
        <div class="perm-group-title">游客权限</div>
        <div class="perm-checks">
          <label v-for="f in GUEST_FLAGS" :key="f.token" class="perm-check">
            <input type="checkbox" v-model="guestMode.permissions[f.token]" />
            {{ f.label }}
          </label>
        </div>
      </div>

      <div v-if="guestMode.enabled" class="perm-group">
        <div class="perm-group-title">可控制的机器人</div>
        <label class="perm-check">
          <input type="checkbox" v-model="guestMode.botsAll" />
          全部机器人
        </label>
        <div v-if="!guestMode.botsAll" class="perm-checks perm-bots">
          <label v-for="bot in store.bots" :key="bot.id" class="perm-check">
            <input
              type="checkbox"
              :checked="guestMode.selectedBotIds.includes(bot.id)"
              @change="toggleGuestBot(bot.id, ($event.target as HTMLInputElement).checked)"
            />
            {{ bot.name }}
          </label>
          <span v-if="store.bots.length === 0" class="user-empty">还没有机器人。</span>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn-primary" :disabled="guestSaving" @click="saveGuestMode">
          {{ guestSaving ? '保存中…' : '保存' }}
        </button>
      </div>
    </section>

    <!-- Command Permissions (admin only) -->
    <section v-if="session.isAdmin.value" class="settings-section">
      <h2 class="section-title">命令权限</h2>
      <p class="profile-section-hint">
        限制谁能在 TeamSpeak 聊天里运行管理类命令（stop / clear / remove / move / vol / mode）。
        填写允许的服务器组 ID（逗号分隔）。留空 = 不限制，所有人可用。如何查看服务器组 ID 见 README。
      </p>
      <div class="setting-row">
        <div class="prefix-input-wrap">
          <input v-model="adminGroupsText" class="input input-sm" placeholder="如 6, 8" />
          <button class="btn-primary" :disabled="adminGroupsSaving" @click="saveAdminGroups">
            {{ adminGroupsSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </section>

    <!-- Bot Profile (TeamSpeak Behavior) -->
    <section v-if="can('bot.manage')" class="settings-section">
      <h2 class="section-title">机器人 Profile（TeamSpeak 行为）</h2>
      <p class="profile-section-hint">控制 bot 在 TeamSpeak 上自动同步歌曲信息的方式。⚠️ 标记的项会触发频道里所有人的提示音。</p>
      <div v-if="store.bots.length === 0" class="empty-hint">还没有机器人，先在上面创建一个。</div>
      <div v-else class="profile-bot-list">
        <div v-for="bot in store.bots" :key="bot.id" class="profile-bot">
          <button
            class="profile-bot-header"
            :class="{ expanded: profileExpanded[bot.id] }"
            @click="toggleProfileExpanded(bot.id)"
          >
            <Icon :icon="profileExpanded[bot.id] ? 'mdi:chevron-down' : 'mdi:chevron-right'" />
            <span class="profile-bot-name">{{ bot.name }}</span>
          </button>
          <div v-if="profileExpanded[bot.id]" class="profile-toggles">
            <div v-if="profileLoadError[bot.id]" class="profile-loading profile-error">
              {{ profileLoadError[bot.id] }}
              <button class="btn-link" @click="loadProfileConfig(bot.id)">重试</button>
            </div>
            <div v-else-if="!profileConfigs[bot.id]" class="profile-loading">加载中...</div>
            <label
              v-else
              v-for="t in PROFILE_TOGGLES"
              :key="t.key"
              class="profile-toggle"
            >
              <div class="profile-toggle-text">
                <div class="profile-toggle-label">
                  {{ t.label }}
                  <span v-if="t.warning" class="profile-warn-tag">⚠️ {{ t.warning }}</span>
                </div>
                <div class="profile-toggle-hint">{{ t.hint }}</div>
              </div>
              <input
                type="checkbox"
                class="profile-toggle-switch"
                :checked="profileConfigs[bot.id][t.key]"
                @change="updateProfile(bot.id, t.key, ($event.target as HTMLInputElement).checked)"
              />
            </label>
            <div v-if="profileConfigs[bot.id]" class="profile-toggle profile-toggle-static">
              <div class="profile-toggle-text">
                <div class="profile-toggle-label">自定义头像</div>
                <div class="profile-toggle-hint">无论封面同步是否开启，停播时都会回到这张图</div>
              </div>
              <CustomAvatarRow :bot-id="bot.id" />
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- User Management -->
    <section v-if="session.isAdmin.value" class="settings-section">
      <h2 class="section-title">用户管理</h2>
      <div class="user-list">
        <div v-for="u in userList" :key="u.id" class="user-row-wrap">
          <div class="user-item">
            <div class="user-info">
              <div class="user-name">
                {{ u.username }}
                <span class="user-role-badge" :class="`role-${u.role}`">
                  {{ u.role === 'admin' ? '管理员' : '成员' }}
                </span>
                <span v-if="session.currentUser.value && u.id === session.currentUser.value.id" class="user-self-badge">本人</span>
              </div>
              <div class="user-created">创建于 {{ formatDate(u.createdAt) }}</div>
            </div>
            <div class="user-actions">
              <span v-if="u.role === 'admin'" class="perm-admin-label">全部权限（管理员）</span>
              <button
                v-else
                class="btn-sm"
                :class="{ 'btn-primary': permEditingId === u.id }"
                @click="onTogglePermEditor(u)"
              >
                <Icon icon="mdi:shield-key" /> 权限
              </button>
              <button class="btn-sm" @click="openResetPassword(u)">
                <Icon icon="mdi:lock-reset" /> 重置密码
              </button>
              <button
                class="btn-sm"
                :disabled="changingRoleId === u.id || isLastAdmin(u)"
                :title="isLastAdmin(u) ? '不能降级唯一的管理员' : (u.role === 'admin' ? '降级为成员' : '提升为管理员')"
                @click="onToggleRole(u)"
              >
                <Icon icon="mdi:account-cog" />
                {{ u.role === 'admin' ? '降为成员' : '提升管理员' }}
              </button>
              <button
                class="btn-sm btn-delete"
                :disabled="!!(session.currentUser.value && u.id === session.currentUser.value.id) || isLastAdmin(u)"
                :title="session.currentUser.value && u.id === session.currentUser.value.id ? '不能删除自己' : (isLastAdmin(u) ? '不能删除唯一的管理员' : '')"
                @click="onDeleteUser(u)"
              >
                <Icon icon="mdi:delete" />
              </button>
            </div>
          </div>

          <!-- Inline permission editor (members only) -->
          <div v-if="permEditingId === u.id" class="perm-editor">
            <div v-if="permLoading" class="user-empty">加载权限中…</div>
            <template v-else>
              <div class="perm-group">
                <div class="perm-group-title">能力</div>
                <div class="perm-checks">
                  <label v-for="cap in CAPABILITIES" :key="cap.token" class="perm-check">
                    <input
                      type="checkbox"
                      :checked="permDraft.capabilities.includes(cap.token)"
                      @change="toggleCapability(cap.token, ($event.target as HTMLInputElement).checked)"
                    />
                    {{ cap.label }}
                  </label>
                </div>
              </div>

              <div class="perm-group">
                <div class="perm-group-title">机器人</div>
                <label class="perm-check">
                  <input type="checkbox" v-model="permDraft.botsAll" />
                  全部机器人
                </label>
                <div v-if="!permDraft.botsAll" class="perm-checks perm-bots">
                  <label v-for="bot in store.bots" :key="bot.id" class="perm-check">
                    <input
                      type="checkbox"
                      :checked="permDraft.selectedBotIds.includes(bot.id)"
                      @change="toggleBotSelection(bot.id, ($event.target as HTMLInputElement).checked)"
                    />
                    {{ bot.name }}
                  </label>
                  <span v-if="store.bots.length === 0" class="user-empty">还没有机器人。</span>
                </div>
              </div>

              <p v-if="permError" class="user-error">{{ permError }}</p>
              <div class="form-actions">
                <button class="btn-sm" @click="permEditingId = null">取消</button>
                <button class="btn-sm btn-primary" :disabled="permSaving" @click="onSavePermissions(u)">
                  {{ permSaving ? '保存中…' : '保存' }}
                </button>
              </div>
            </template>
          </div>
        </div>
        <div v-if="userList.length === 0 && !userLoadError" class="user-empty">加载中…</div>
        <div v-if="userLoadError" class="user-error">{{ userLoadError }}</div>
      </div>

      <form class="user-add-form" @submit.prevent="onCreateUser">
        <input v-model="newUser.username" class="input" placeholder="新用户名 (3-32 字符)" required />
        <input v-model="newUser.password" type="password" class="input" placeholder="密码 (≥8 位)" minlength="8" required />
        <select v-model="newUser.role" class="input user-role-select">
          <option value="member">成员</option>
          <option value="admin">管理员</option>
        </select>
        <button class="btn-sm btn-primary" type="submit" :disabled="creatingUser">
          {{ creatingUser ? '创建中…' : '添加用户' }}
        </button>
      </form>
      <p v-if="userMutationError" class="user-error">{{ userMutationError }}</p>

      <!-- Reset password modal -->
      <div v-if="resetTarget" class="edit-modal-overlay" @click.self="resetTarget = null">
        <div class="edit-modal">
          <h3 class="modal-title">重置 {{ resetTarget.username }} 的密码</h3>
          <p class="modal-hint">该用户的所有会话将被强制下线。</p>
          <div class="form-group">
            <label>新密码 (≥8 位)</label>
            <input v-model="resetPassword" type="password" class="input" minlength="8" />
          </div>
          <p v-if="resetError" class="user-error">{{ resetError }}</p>
          <div class="form-actions">
            <button class="btn-sm" @click="resetTarget = null">取消</button>
            <button class="btn-sm btn-primary" :disabled="resettingPw" @click="onConfirmReset">
              {{ resettingPw ? '保存中…' : '确认重置' }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Audit Log -->
    <section v-if="session.isAdmin.value" class="settings-section">
      <h2 class="section-title">
        操作审计
        <button class="audit-refresh-btn" @click="loadAudit" :disabled="auditLoading" title="刷新">
          <Icon icon="mdi:refresh" :class="{ spinning: auditLoading }" />
        </button>
      </h2>
      <div v-if="auditLoadError" class="user-error">{{ auditLoadError }}</div>
      <div v-else-if="auditEntries.length === 0 && !auditLoading" class="user-empty">暂无操作记录</div>
      <div v-else class="audit-list">
        <div v-for="e in auditEntries" :key="e.id" class="audit-row">
          <div class="audit-time">{{ formatDateTime(e.timestamp) }}</div>
          <div class="audit-actor">{{ e.actorUsername ?? '—' }}</div>
          <div class="audit-action" :class="auditActionClass(e.action)">{{ describeAction(e) }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import AvatarUpload from '../components/AvatarUpload.vue';
import CustomAvatarRow from '../components/CustomAvatarRow.vue';
import QRCode from 'qrcode';
import { usePlayerStore } from '../stores/player.js';
import { useSession } from '../composables/useSession.js';
import {
  buildSpotifyPayload,
  parseSpotifyRedirect,
  statusSummary,
  SPOTIFY_DISCLAIMER,
  type SpotifyConfigForm,
  type SpotifyStatus,
} from '../composables/useSpotifySettings.js';

const store = usePlayerStore();

function botStatusClass(bot: any) {
  if (!bot.connected) return 'offline';
  if (bot.playing) return 'playing';
  if (bot.paused) return 'paused';
  return 'online';
}

function botStatusText(bot: any) {
  if (!bot.connected) return '离线';
  if (bot.playing) return '播放中';
  if (bot.paused) return '已暂停';
  return '在线';
}

const newBotName = ref('');
const newBotServer = ref('');
const newBotPort = ref(9987);
const newBotNickname = ref('MusicBot');
const newBotChannel = ref('');
const newBotChannelId = ref('');
const newBotServerPassword = ref('');
const newBotAvatar = ref<string | null>(null);

// Edit bot
const editingBot = ref<string | null>(null);
const editForm = reactive({
  name: '',
  serverAddress: '',
  serverPort: 9987,
  nickname: '',
  defaultChannel: '',
  channelId: '',
  channelPassword: '',
  serverPassword: '',
});

const neteaseCookie = ref('');
const qqCookie = ref('');
const bilibiliCookie = ref('');
const kugouCookie = ref('');
const commandPrefix = ref('!');

// Audio quality
const currentQuality = ref('exhigh');
const qualityLevels = [
  { value: 'standard', label: '标准', desc: '128kbps MP3' },
  { value: 'higher', label: '较高', desc: '192kbps MP3' },
  { value: 'exhigh', label: '极高', desc: '320kbps MP3' },
  { value: 'lossless', label: '无损', desc: 'FLAC' },
  { value: 'hires', label: 'Hi-Res', desc: '高解析度' },
  { value: 'jymaster', label: '超清母带', desc: '最高质量' },
];

// Jellyfin quality tiers (direct = untranscoded original; the rest are
// server-side transcodes for low-bandwidth Jellyfin links).
const jellyfinQuality = ref('direct');
const jellyfinQualityLevels = [
  { value: 'direct', label: '原始直传', desc: 'Direct（无转码）' },
  { value: '320', label: '320kbps', desc: '服务器转码' },
  { value: '192', label: '192kbps', desc: '服务器转码' },
  { value: '128', label: '128kbps', desc: '服务器转码' },
];

async function loadQuality() {
  try {
    const res = await axios.get('/api/music/quality');
    currentQuality.value = res.data.netease || 'exhigh';
    jellyfinQuality.value = res.data.jellyfin || 'direct';
  } catch { /* ignore */ }
}

async function setQuality(q: string) {
  currentQuality.value = q;
  try {
    await axios.post('/api/music/quality', { quality: q });
  } catch { /* ignore */ }
}

async function setJellyfinQuality(q: string) {
  jellyfinQuality.value = q;
  try {
    await axios.post('/api/music/quality', { quality: q, platform: 'jellyfin' });
  } catch { /* ignore */ }
}

// Login mode: 'qr' | 'cookie' | null
const neteaseLoginMode = ref<'qr' | 'cookie' | null>(null);
const qqLoginMode = ref<'qr' | 'cookie' | null>(null);
const bilibiliLoginMode = ref<'qr' | 'cookie' | null>(null);
const kugouLoginMode = ref<'qr' | 'cookie' | null>(null);

// Auth status
const neteaseAuth = reactive({ loggedIn: false, nickname: '', avatarUrl: '' });
const qqAuth = reactive({ loggedIn: false, nickname: '', avatarUrl: '' });
const bilibiliAuth = reactive({ loggedIn: false, nickname: '', avatarUrl: '' });
const kugouAuth = reactive({ loggedIn: false, nickname: '', avatarUrl: '' });
const jellyfinAuth = reactive({ loggedIn: false, nickname: '' });

// Server-side source gate (enabledProviders): cards for disabled sources are
// hidden. Empty until GET /api/bot/settings responds — treat as all-on so a
// slow load doesn't blank the page.
const enabledProviders = ref<string[]>([]);
function providerOn(p: string): boolean {
  return enabledProviders.value.length === 0 || enabledProviders.value.includes(p);
}

// --- Default music source (issue #126) ---
// Chinese labels for the gateable providers, shown in the default-source select.
const PROVIDER_LABELS: Record<string, string> = {
  netease: '网易云音乐',
  qq: 'QQ音乐',
  kugou: '酷狗音乐',
  bilibili: '哔哩哔哩',
  youtube: 'YouTube',
  jellyfin: 'Jellyfin',
};
// Empty string = "auto" (follow the fixed priority order); persisted as null.
const defaultPlatformForm = ref('');
const defaultSourceSaving = ref(false);
const defaultSourceMessage = ref('');
const defaultSourceMessageTone = ref<'ok' | 'warn'>('ok');
// Only currently-enabled sources can be picked as the default.
const defaultSourceOptions = computed(() =>
  enabledProviders.value
    .filter((p) => p in PROVIDER_LABELS)
    .map((p) => ({ value: p, label: PROVIDER_LABELS[p] })),
);

async function saveDefaultSource() {
  defaultSourceSaving.value = true;
  defaultSourceMessage.value = '';
  try {
    const res = await axios.post('/api/bot/settings', {
      defaultPlatform: defaultPlatformForm.value || null,
    });
    defaultPlatformForm.value = res.data?.defaultPlatform ?? '';
    // Push the new default across the app immediately (search bar / play calls
    // read store.defaultSource, refreshed via GET /api/music/providers).
    await store.fetchProviders();
    defaultSourceMessageTone.value = 'ok';
    defaultSourceMessage.value = '已保存';
  } catch (err: any) {
    defaultSourceMessageTone.value = 'warn';
    defaultSourceMessage.value = err?.response?.status === 403
      ? '没有权限修改设置（需要 bot.manage）'
      : '保存失败，请稍后重试';
  } finally {
    defaultSourceSaving.value = false;
  }
}

// --- Jellyfin connection (admin-configured; password/apiKey are write-only) ---
const jellyfinForm = reactive({
  serverUrl: '',
  authMode: 'userpass' as 'userpass' | 'apikey',
  username: '',
  password: '',
  apiKey: '',
  userId: '',
});
const jellyfinHasPassword = ref(false);
const jellyfinHasApiKey = ref(false);
const jellyfinSaving = ref(false);
const jellyfinTesting = ref(false);
const jellyfinMessage = ref('');
const jellyfinMessageTone = ref<'ok' | 'warn'>('ok');
// Jellyfin is opt-in: its "enabled" bit is membership in enabledProviders
// (unlike Spotify's dedicated spotify.enabled flag). Only trust the toggle
// once the real list has loaded, so an early save can't clobber the other
// providers with the empty placeholder list.
const jellyfinEnabledForm = ref(false);
const enabledProvidersLoaded = ref(false);

// Populate from the masked GET /api/bot/settings response — secrets never
// round-trip, only hasPassword/hasApiKey.
function applyJellyfinConfig(jf: any) {
  if (!jf || typeof jf !== 'object') return;
  jellyfinForm.serverUrl = typeof jf.serverUrl === 'string' ? jf.serverUrl : '';
  if (jf.authMode === 'userpass' || jf.authMode === 'apikey') jellyfinForm.authMode = jf.authMode;
  jellyfinForm.username = typeof jf.username === 'string' ? jf.username : '';
  jellyfinForm.userId = typeof jf.userId === 'string' ? jf.userId : '';
  jellyfinForm.password = ''; // blank on load; blank on save = unchanged
  jellyfinForm.apiKey = '';
  jellyfinHasPassword.value = Boolean(jf.hasPassword);
  jellyfinHasApiKey.value = Boolean(jf.hasApiKey);
}

async function saveJellyfin() {
  jellyfinSaving.value = true;
  jellyfinMessage.value = '';
  try {
    // enabledProviders is a full-replace field, so only send it when the
    // current list is known — otherwise we'd wipe the other sources.
    const payload: Record<string, unknown> = { jellyfin: { ...jellyfinForm } };
    if (enabledProvidersLoaded.value) {
      const others = enabledProviders.value.filter((p) => p !== 'jellyfin');
      payload.enabledProviders = jellyfinEnabledForm.value ? [...others, 'jellyfin'] : others;
    }
    const res = await axios.post('/api/bot/settings', payload);
    applyJellyfinConfig(res.data?.jellyfin);
    if (Array.isArray(res.data?.enabledProviders)) {
      enabledProviders.value = res.data.enabledProviders;
      jellyfinEnabledForm.value = res.data.enabledProviders.includes('jellyfin');
      enabledProvidersLoaded.value = true;
      // Search bar / home sections / FM cards react without a reload.
      store.fetchProviders();
    }
    // Disabling a source can clear a default that pointed at it (backend
    // reconciles enabledProviders → defaultPlatform); keep the select in sync.
    if (res.data && 'defaultPlatform' in res.data) {
      defaultPlatformForm.value = res.data.defaultPlatform ?? '';
    }
    jellyfinMessageTone.value = 'ok';
    jellyfinMessage.value = '已保存';
    await checkAuthStatus();
  } catch (err: any) {
    jellyfinMessageTone.value = 'warn';
    jellyfinMessage.value = err?.response?.status === 403
      ? '没有权限修改设置（需要 bot.manage）'
      : '保存失败，请稍后重试';
  } finally {
    jellyfinSaving.value = false;
  }
}

// Round-trips /System/Info with the CURRENT form values (empty secret fields
// fall back to the stored ones server-side), without touching saved config.
async function testJellyfin() {
  jellyfinTesting.value = true;
  jellyfinMessage.value = '';
  try {
    const res = await axios.post('/api/auth/jellyfin/test', { ...jellyfinForm });
    if (res.data?.ok) {
      jellyfinMessageTone.value = 'ok';
      jellyfinMessage.value = `连接成功：${res.data.serverName ?? 'Jellyfin'} ${res.data.version ?? ''}`;
    } else {
      jellyfinMessageTone.value = 'warn';
      jellyfinMessage.value = `连接失败：${res.data?.error ?? '未知错误'}`;
    }
  } catch (err: any) {
    jellyfinMessageTone.value = 'warn';
    jellyfinMessage.value = err?.response?.status === 403
      ? '没有权限执行平台登录（需要 platform.auth）'
      : '测试请求失败，请稍后重试';
  } finally {
    jellyfinTesting.value = false;
  }
}

// QR state
interface QrState {
  loading: boolean;
  dataUrl: string;
  key: string;
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired';
  pollTimer: ReturnType<typeof setInterval> | null;
}

const neteaseQr = reactive<QrState>({
  loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null,
});
const qqQr = reactive<QrState>({
  loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null,
});
const bilibiliQr = reactive<QrState>({
  loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null,
});
const kugouQr = reactive<QrState>({
  loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null,
});

function getQrState(platform: string): QrState {
  if (platform === 'bilibili') return bilibiliQr;
  if (platform === 'kugou') return kugouQr;
  return platform === 'netease' ? neteaseQr : qqQr;
}

async function checkAuthStatus() {
  // allSettled: one slow/unconfigured platform must not hide the others'
  // status (jellyfin probes its server with a real HTTP round-trip).
  const [nRes, qRes, bRes, kRes, jRes] = await Promise.allSettled([
    axios.get('/api/auth/status', { params: { platform: 'netease' } }),
    axios.get('/api/auth/status', { params: { platform: 'qq' } }),
    axios.get('/api/auth/status', { params: { platform: 'bilibili' } }),
    axios.get('/api/auth/status', { params: { platform: 'kugou' } }),
    axios.get('/api/auth/status', { params: { platform: 'jellyfin' } }),
  ]);
  if (nRes.status === 'fulfilled') Object.assign(neteaseAuth, nRes.value.data);
  if (qRes.status === 'fulfilled') Object.assign(qqAuth, qRes.value.data);
  if (bRes.status === 'fulfilled') Object.assign(bilibiliAuth, bRes.value.data);
  if (kRes.status === 'fulfilled') Object.assign(kugouAuth, kRes.value.data);
  if (jRes.status === 'fulfilled') {
    jellyfinAuth.loggedIn = Boolean(jRes.value.data?.loggedIn);
    jellyfinAuth.nickname = jRes.value.data?.nickname ?? '';
  }
}

async function startQrLogin(platform: string) {
  const qr = getQrState(platform);
  if (platform === 'netease') neteaseLoginMode.value = 'qr';
  else if (platform === 'bilibili') bilibiliLoginMode.value = 'qr';
  else if (platform === 'kugou') kugouLoginMode.value = 'qr';
  else qqLoginMode.value = 'qr';

  // Stop existing poll
  if (qr.pollTimer) clearInterval(qr.pollTimer);
  qr.loading = true;
  qr.dataUrl = '';
  qr.status = 'waiting';

  try {
    const res = await axios.post('/api/auth/qrcode', { platform });
    const { qrUrl, qrImg, key } = res.data;
    qr.key = key;

    // Use server-generated QR image if available, otherwise generate client-side
    if (qrImg) {
      qr.dataUrl = qrImg;
    } else {
      // QR codes must be dark-on-light to stay scannable. Do NOT invert the
      // colours for the dark theme: many in-app scanners (notably the Kugou
      // music app) cannot decode a light-on-dark QR, so a themed code looks
      // fine on screen but silently fails to scan. The white quiet-zone frames
      // it cleanly in dark mode anyway.
      qr.dataUrl = await QRCode.toDataURL(qrUrl, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
    }

    qr.loading = false;

    // Start polling
    qr.pollTimer = setInterval(() => pollQrStatus(platform), 2000);
  } catch (err) {
    qr.loading = false;
    console.error('QR generation failed:', err);
  }
}

async function pollQrStatus(platform: string) {
  const qr = getQrState(platform);
  if (!qr.key) return;

  try {
    const res = await axios.get('/api/auth/qrcode/status', {
      params: { key: qr.key, platform },
    });
    qr.status = res.data.status;

    if (qr.status === 'confirmed') {
      if (qr.pollTimer) clearInterval(qr.pollTimer);
      qr.pollTimer = null;
      // Refresh auth status
      await checkAuthStatus();
    } else if (qr.status === 'expired') {
      if (qr.pollTimer) clearInterval(qr.pollTimer);
      qr.pollTimer = null;
    }
  } catch {
    // Ignore poll errors
  }
}

async function createBot() {
  if (!newBotName.value || !newBotServer.value) return;
  try {
    const res = await axios.post('/api/bot', {
      name: newBotName.value,
      serverAddress: newBotServer.value,
      serverPort: newBotPort.value || 9987,
      nickname: newBotNickname.value || newBotName.value,
      defaultChannel: newBotChannel.value || undefined,
      channelId: newBotChannelId.value || undefined,
      serverPassword: newBotServerPassword.value || undefined,
      autoStart: false,
    });
    if (newBotAvatar.value && res.data?.id) {
      try {
        await axios.put(`/api/bot/${res.data.id}/avatar`, { dataUrl: newBotAvatar.value });
      } catch (err) {
        console.warn('failed to set avatar on new bot', err);
      }
    }
    newBotName.value = '';
    newBotServer.value = '';
    newBotPort.value = 9987;
    newBotNickname.value = 'MusicBot';
    newBotChannel.value = '';
    newBotChannelId.value = '';
    newBotServerPassword.value = '';
    newBotAvatar.value = null;
    await store.fetchBots();
  } catch {
    // Ignore
  }
}

async function deleteBot(botId: string, botName: string) {
  if (!confirm(`确认删除机器人 "${botName}"？此操作不可撤销。`)) return;
  try {
    await axios.delete(`/api/bot/${botId}`);
    // If deleted bot was the active one, reset activeBotId
    if (store.activeBotId === botId) {
      store.activeBotId = null;
    }
    store.removeBotStatus(botId);
    await store.fetchBots();
  } catch {
    // Ignore
  }
}

async function openEditBot(bot: any) {
  editingBot.value = bot.id;
  editForm.name = bot.name;
  // Fetch saved config to fill all fields
  try {
    const res = await axios.get(`/api/bot/${bot.id}/config`);
    editForm.serverAddress = res.data.serverAddress ?? '';
    editForm.serverPort = res.data.serverPort ?? 9987;
    editForm.nickname = res.data.nickname ?? '';
    editForm.defaultChannel = res.data.defaultChannel ?? '';
    editForm.channelId = res.data.channelId ?? '';
    editForm.channelPassword = res.data.channelPassword ?? '';
    editForm.serverPassword = res.data.serverPassword ?? '';
  } catch {
    // Config not found — use defaults
    editForm.serverAddress = '';
    editForm.serverPort = 9987;
    editForm.nickname = bot.name;
    editForm.defaultChannel = '';
    editForm.channelId = '';
    editForm.channelPassword = '';
    editForm.serverPassword = '';
  }
}

async function saveEditBot() {
  if (!editingBot.value) return;
  try {
    await axios.put(`/api/bot/${editingBot.value}`, editForm);
    editingBot.value = null;
    await store.fetchBots();
  } catch {
    // Ignore
  }
}

async function toggleBot(botId: string, connected: boolean) {
  try {
    if (connected) {
      await axios.post(`/api/bot/${botId}/stop`);
    } else {
      await axios.post(`/api/bot/${botId}/start`);
    }
    await store.fetchBots();
  } catch {
    // Ignore
  }
}

async function saveCookie(platform: string) {
  const cookie = platform === 'bilibili' ? bilibiliCookie.value
    : platform === 'kugou' ? kugouCookie.value
    : platform === 'netease' ? neteaseCookie.value : qqCookie.value;
  if (!cookie) return;
  try {
    await axios.post('/api/auth/cookie', { platform, cookie });
    await checkAuthStatus();
  } catch {
    // Ignore
  }
}

async function savePrefix() {
  // Prefix is saved client-side for now
}

// Idle timeout
const idleTimeout = ref(0);
// Defaults OFF to match the backend default (config.ts getDefaultConfig).
const autoPauseOnEmpty = ref(false);
// Voice ducking defaults OFF and retains 30% of the configured player volume.
const voiceDuckingEnabled = ref(false);
const voiceDuckingVolumePercent = ref(30);
const voiceDuckingLoaded = ref(false);
const voiceDuckingSaving = ref(false);
const voiceDuckingControlsDisabled = computed(
  () => !voiceDuckingLoaded.value || voiceDuckingSaving.value,
);
const voiceDuckingMessage = ref('');
const voiceDuckingMessageTone = ref<'ok' | 'warn'>('ok');
let savedVoiceDucking = { enabled: false, volumePercent: 30 };
let voiceDuckingRequestRevision = 0;
const localAudioEnabled = ref(true);
// Saved-queues + play-keeps-queue toggles (#119), both default OFF.
const savedQueuesEnabled = ref(false);
const playKeepsQueue = ref(false);

function normalizeVoiceDuckingVolume(): number {
  const raw = voiceDuckingVolumePercent.value as number | string;
  const value = raw === '' ? Number.NaN : Number(raw);
  voiceDuckingVolumePercent.value = Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : savedVoiceDucking.volumePercent;
  return voiceDuckingVolumePercent.value;
}

function applyVoiceDuckingConfig(config: unknown) {
  if (!config || typeof config !== 'object') return;
  const value = config as { enabled?: unknown; volumePercent?: unknown };
  voiceDuckingEnabled.value = typeof value.enabled === 'boolean' ? value.enabled : false;
  const percent = value.volumePercent;
  voiceDuckingVolumePercent.value = typeof percent === 'number' && Number.isFinite(percent)
    ? Math.min(100, Math.max(0, percent))
    : 30;
  savedVoiceDucking = {
    enabled: voiceDuckingEnabled.value,
    volumePercent: voiceDuckingVolumePercent.value,
  };
}

async function loadIdleTimeout() {
  const voiceDuckingLoadRevision = voiceDuckingRequestRevision;
  try {
    const res = await axios.get('/api/bot/settings');
    idleTimeout.value = res.data.idleTimeoutMinutes ?? 0;
    autoPauseOnEmpty.value = res.data.autoPauseOnEmpty ?? false;
    // A later save owns the state. Do not let an older GET response overwrite
    // it if this loader is ever re-entered while a POST is in flight.
    if (voiceDuckingLoadRevision === voiceDuckingRequestRevision) {
      applyVoiceDuckingConfig(res.data.voiceDucking ?? { enabled: false, volumePercent: 30 });
      voiceDuckingLoaded.value = true;
      voiceDuckingMessage.value = '';
    }
    localAudioEnabled.value = res.data.localAudioEnabled ?? true;
    savedQueuesEnabled.value = res.data.savedQueuesEnabled ?? false;
    playKeepsQueue.value = res.data.playKeepsQueue ?? false;
    store.savedQueuesEnabled = savedQueuesEnabled.value;
    applyGuestModeFromServer(res.data.guestMode);
    applyAdminGroupsFromServer(res.data.adminGroups);
    applySpotifyConfig(res.data.spotify);
    applyJellyfinConfig(res.data.jellyfin);
    if (Array.isArray(res.data.enabledProviders)) {
      enabledProviders.value = res.data.enabledProviders;
      jellyfinEnabledForm.value = res.data.enabledProviders.includes('jellyfin');
      enabledProvidersLoaded.value = true;
    }
    // null (unset) → "" so the select shows "自动（按优先级）".
    defaultPlatformForm.value = res.data.defaultPlatform ?? '';
  } catch {
    if (!voiceDuckingLoaded.value) {
      voiceDuckingMessageTone.value = 'warn';
      voiceDuckingMessage.value = '语音闪避设置加载失败，请刷新页面重试';
    }
  }
}

async function saveIdleTimeout() {
  try {
    await axios.post('/api/bot/settings', { idleTimeoutMinutes: idleTimeout.value });
  } catch { /* ignore */ }
}

async function saveAutoPause() {
  try {
    await axios.post('/api/bot/settings', { autoPauseOnEmpty: autoPauseOnEmpty.value });
  } catch { /* ignore */ }
}

async function saveVoiceDucking() {
  if (!voiceDuckingLoaded.value || voiceDuckingSaving.value) return;
  voiceDuckingSaving.value = true;
  voiceDuckingRequestRevision++;
  voiceDuckingMessage.value = '';
  const submitted = {
    enabled: voiceDuckingEnabled.value,
    volumePercent: normalizeVoiceDuckingVolume(),
  };
  try {
    const res = await axios.post('/api/bot/settings', { voiceDucking: submitted });
    applyVoiceDuckingConfig(res.data?.voiceDucking ?? submitted);
    voiceDuckingMessageTone.value = 'ok';
    voiceDuckingMessage.value = '已保存';
  } catch {
    applyVoiceDuckingConfig(savedVoiceDucking);
    voiceDuckingMessageTone.value = 'warn';
    voiceDuckingMessage.value = '保存失败，请稍后重试';
  } finally {
    voiceDuckingSaving.value = false;
  }
}

async function saveLocalAudioEnabled() {
  try {
    const res = await axios.post('/api/bot/settings', { localAudioEnabled: localAudioEnabled.value });
    localAudioEnabled.value = res.data.localAudioEnabled ?? localAudioEnabled.value;
  } catch { /* ignore */ }
}

async function saveSavedQueuesEnabled() {
  try {
    const res = await axios.post('/api/bot/settings', { savedQueuesEnabled: savedQueuesEnabled.value });
    savedQueuesEnabled.value = res.data.savedQueuesEnabled ?? savedQueuesEnabled.value;
    // Keep the shared store flag (nav gate) in sync without a reload.
    store.savedQueuesEnabled = savedQueuesEnabled.value;
  } catch { /* ignore */ }
}

async function savePlayKeepsQueue() {
  try {
    const res = await axios.post('/api/bot/settings', { playKeepsQueue: playKeepsQueue.value });
    playKeepsQueue.value = res.data.playKeepsQueue ?? playKeepsQueue.value;
  } catch { /* ignore */ }
}

// --- Spotify (Connect) settings (§8) ---
// NOTE: This card's status comes ONLY from /api/spotify/status (playback OAuth
// `authorized`). It is deliberately NOT wired to the player store's
// authStatus.spotify (which reflects /api/auth/status?platform=spotify — the
// separate metadata Web-API login). Keep the two concepts distinct.
const spotifyForm = reactive<SpotifyConfigForm>({
  enabled: false,
  backend: 'auto',
  clientId: '',
  clientSecret: '',
  deviceName: 'TSMusicBot',
  bitrate: 320,
});
const spotifyHasSecret = ref(false);
const spotifyStatus = ref<SpotifyStatus | null>(null);
const spotifySaving = ref(false);
const spotifyConnecting = ref(false);
const spotifyMessage = ref('');
const spotifyMessageTone = ref<'ok' | 'warn'>('ok');

const SPOTIFY_BACKENDS: { value: SpotifyConfigForm['backend']; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'go-librespot', label: 'go-librespot' },
  { value: 'librespot', label: 'librespot' },
];
const SPOTIFY_BITRATES = [96, 160, 320];

const spotifyStatusSummary = computed(() => statusSummary(spotifyStatus.value, spotifyForm.enabled));

// Populate the form from the masked GET /api/bot/settings response. The raw
// clientSecret is write-only and never returned — only `hasClientSecret`.
function applySpotifyConfig(sp: any) {
  if (!sp || typeof sp !== 'object') return;
  spotifyForm.enabled = Boolean(sp.enabled);
  if (sp.backend === 'auto' || sp.backend === 'go-librespot' || sp.backend === 'librespot') {
    spotifyForm.backend = sp.backend;
  }
  spotifyForm.clientId = typeof sp.clientId === 'string' ? sp.clientId : '';
  spotifyForm.deviceName = typeof sp.deviceName === 'string' ? sp.deviceName : '';
  if (typeof sp.bitrate === 'number') spotifyForm.bitrate = sp.bitrate;
  spotifyForm.clientSecret = ''; // always blank on load; blank on save = unchanged
  spotifyHasSecret.value = Boolean(sp.hasClientSecret);
}

async function loadSpotifyStatus() {
  try {
    const res = await axios.get('/api/spotify/status');
    spotifyStatus.value = res.data;
  } catch {
    spotifyStatus.value = null;
  }
}

async function saveSpotify() {
  spotifySaving.value = true;
  try {
    const res = await axios.post('/api/bot/settings', buildSpotifyPayload(spotifyForm));
    applySpotifyConfig(res.data?.spotify);
    await loadSpotifyStatus();
  } catch { /* ignore */ } finally {
    spotifySaving.value = false;
  }
}

async function connectSpotify() {
  spotifyConnecting.value = true;
  spotifyMessage.value = '';
  try {
    const { data } = await axios.get('/api/spotify/login');
    window.location.href = data.url;
  } catch (err: any) {
    spotifyConnecting.value = false;
    spotifyMessageTone.value = 'warn';
    spotifyMessage.value = err?.response?.status === 403
      ? '没有权限执行平台登录（需要 platform.auth）'
      : '无法开始 Spotify 授权，请稍后重试';
  }
}

// On mount, surface the ?spotify=success|error redirect result, then strip the
// param so a refresh doesn't re-show it.
function handleSpotifyRedirect() {
  const r = parseSpotifyRedirect(window.location.search);
  if (!r) return;
  spotifyMessageTone.value = r === 'success' ? 'ok' : 'warn';
  spotifyMessage.value = r === 'success' ? 'Spotify 授权成功' : 'Spotify 授权失败或被取消';
  const url = new URL(window.location.href);
  url.searchParams.delete('spotify');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

// --- Guest mode (admin only) ---
const GUEST_FLAGS: { token: string; label: string }[] = [
  { token: 'addToQueue', label: '添加到队列末尾' },
  { token: 'playNext', label: '添加到下一首' },
  { token: 'playNow', label: '立即播放（不清空队列）' },
  { token: 'skip', label: '跳过当前歌曲' },
  { token: 'transport', label: '暂停/继续/进度/音量' },
  { token: 'removeClear', label: '移除/清空队列' },
  { token: 'playMode', label: '切换播放模式 / FM' },
  { token: 'playCollection', label: '播放整个歌单/专辑' },
];
const guestMode = reactive<{ enabled: boolean; botsAll: boolean; selectedBotIds: string[]; permissions: Record<string, boolean> }>({
  enabled: false,
  botsAll: true,
  selectedBotIds: [],
  permissions: { addToQueue: true, playNext: false, playNow: false, skip: false, transport: false, removeClear: false, playMode: false, playCollection: false },
});
const guestSaving = ref(false);

function applyGuestModeFromServer(gm: any) {
  if (!gm) return;
  guestMode.enabled = Boolean(gm.enabled);
  guestMode.botsAll = gm.bots === 'all';
  guestMode.selectedBotIds = Array.isArray(gm.bots) ? [...gm.bots] : [];
  for (const f of GUEST_FLAGS) {
    guestMode.permissions[f.token] = Boolean(gm.permissions?.[f.token]);
  }
}

function toggleGuestBot(id: string, checked: boolean) {
  const has = guestMode.selectedBotIds.includes(id);
  if (checked && !has) guestMode.selectedBotIds.push(id);
  else if (!checked && has) guestMode.selectedBotIds = guestMode.selectedBotIds.filter((b) => b !== id);
}

async function saveGuestMode() {
  guestSaving.value = true;
  try {
    const res = await axios.post('/api/bot/settings', {
      guestMode: {
        enabled: guestMode.enabled,
        bots: guestMode.botsAll ? 'all' : [...guestMode.selectedBotIds],
        permissions: { ...guestMode.permissions },
      },
    });
    applyGuestModeFromServer(res.data?.guestMode);
  } catch { /* ignore */ } finally {
    guestSaving.value = false;
  }
}

// --- Command permissions (admin only) ---
const adminGroupsText = ref('');
const adminGroupsSaving = ref(false);

function applyAdminGroupsFromServer(groups: unknown) {
  if (Array.isArray(groups)) {
    adminGroupsText.value = groups.filter((g) => typeof g === 'number').join(', ');
  }
}

function parseAdminGroups(text: string): number[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

async function saveAdminGroups() {
  adminGroupsSaving.value = true;
  try {
    const res = await axios.post('/api/bot/settings', { adminGroups: parseAdminGroups(adminGroupsText.value) });
    applyAdminGroupsFromServer(res.data?.adminGroups);
  } catch { /* ignore */ } finally {
    adminGroupsSaving.value = false;
  }
}

// --- Bot Profile config ---
interface ProfileConfig {
  avatarEnabled: boolean;
  descriptionEnabled: boolean;
  nicknameEnabled: boolean;
  awayStatusEnabled: boolean;
  channelDescEnabled: boolean;
  nowPlayingMsgEnabled: boolean;
}

const PROFILE_TOGGLES: ReadonlyArray<{
  key: keyof ProfileConfig;
  label: string;
  hint: string;
  warning: string | null;
}> = [
  { key: 'avatarEnabled',       label: '同步头像',           hint: '使用专辑封面作为 bot 头像',                  warning: null },
  { key: 'descriptionEnabled',  label: '同步个人描述',       hint: '在 bot 简介里显示当前播放的歌曲',            warning: null },
  { key: 'nicknameEnabled',     label: '同步昵称',           hint: 'bot 昵称跟着歌名变化',                       warning: null },
  { key: 'awayStatusEnabled',   label: '走开状态',           hint: '停止播放时把 bot 设为"走开"',               warning: null },
  { key: 'channelDescEnabled',  label: '更新频道描述',       hint: '把"正在播放"信息写入频道描述',             warning: '频道编辑提示音' },
  { key: 'nowPlayingMsgEnabled',label: '推送"正在播放"消息', hint: '切歌时在频道里发一条文字消息',               warning: '新消息提示音' },
];

const profileConfigs = reactive<Record<string, ProfileConfig>>({});
const profileExpanded = reactive<Record<string, boolean>>({});
const profileLoadError = reactive<Record<string, string | null>>({});

async function loadProfileConfig(botId: string) {
  if (profileConfigs[botId]) return;
  profileLoadError[botId] = null;
  try {
    const res = await axios.get(`/api/player/${botId}/profile`);
    // Defensive: a 200 response with non-object body (empty / proxy
    // injection / etc.) would otherwise leave the row stuck on
    // "加载中..." because profileConfigs[botId] would be falsy.
    if (!res.data || typeof res.data !== 'object' || typeof res.data.avatarEnabled !== 'boolean') {
      profileLoadError[botId] = '响应格式异常';
      return;
    }
    profileConfigs[botId] = res.data;
  } catch (err: any) {
    profileLoadError[botId] = err?.response?.status === 404
      ? '机器人未加载'
      : '加载失败，请重试';
  }
}

function toggleProfileExpanded(botId: string) {
  profileExpanded[botId] = !profileExpanded[botId];
  if (profileExpanded[botId]) loadProfileConfig(botId);
}

async function updateProfile(botId: string, key: keyof ProfileConfig, value: boolean) {
  const cfg = profileConfigs[botId];
  if (!cfg) return;
  const prev = cfg[key];
  cfg[key] = value; // optimistic
  try {
    const res = await axios.put(`/api/player/${botId}/profile`, { [key]: value });
    profileConfigs[botId] = res.data;
  } catch {
    cfg[key] = prev; // revert
  }
}

// --- User Management ---
const session = useSession();
const { can } = session;

// --- Own password change (available to all authenticated users) ---
const ownPw = reactive({ old: '', new: '', confirm: '' });
const ownPwError = ref('');
const ownPwSuccess = ref('');
const changingOwnPw = ref(false);

async function onChangeOwnPassword() {
  ownPwError.value = '';
  ownPwSuccess.value = '';
  if (ownPw.new !== ownPw.confirm) {
    ownPwError.value = '两次输入的新密码不一致';
    return;
  }
  if (ownPw.new.length < 8) {
    ownPwError.value = '新密码至少 8 位';
    return;
  }
  changingOwnPw.value = true;
  try {
    const res = await fetch('/api/session/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: ownPw.old, newPassword: ownPw.new }),
    });
    if (!res.ok && res.status !== 204) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error ?? `HTTP ${res.status}`);
    }
    ownPw.old = '';
    ownPw.new = '';
    ownPw.confirm = '';
    ownPwSuccess.value = '密码已更新';
    // The server kills other sessions but keeps the current one. No reload needed.
  } catch (e) {
    ownPwError.value = (e as Error).message;
  } finally {
    changingOwnPw.value = false;
  }
}

interface UserListEntry { id: string; username: string; createdAt: number; role: 'admin' | 'member' }
const userList = ref<UserListEntry[]>([]);
const userLoadError = ref('');
const userMutationError = ref('');
const newUser = reactive({ username: '', password: '', role: 'member' as 'admin' | 'member' });
const creatingUser = ref(false);
const resetTarget = ref<UserListEntry | null>(null);
const resetPassword = ref('');
const resetError = ref('');
const resettingPw = ref(false);
const changingRoleId = ref<string | null>(null);

function isLastAdmin(u: UserListEntry): boolean {
  if (u.role !== 'admin') return false;
  const adminCount = userList.value.filter((x) => x.role === 'admin').length;
  return adminCount <= 1;
}

async function onToggleRole(u: UserListEntry) {
  const newRole = u.role === 'admin' ? 'member' : 'admin';
  if (!confirm(`确认将 ${u.username} 切换为${newRole === 'admin' ? '管理员' : '成员'}？`)) return;
  userMutationError.value = '';
  changingRoleId.value = u.id;
  try {
    const res = await fetch(`/api/users/${u.id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });
    if (!res.ok && res.status !== 204) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error ?? `HTTP ${res.status}`);
    }
    await loadUsers();
  } catch (e) {
    userMutationError.value = (e as Error).message;
  } finally {
    changingRoleId.value = null;
  }
}

async function loadUsers() {
  userLoadError.value = '';
  try {
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    userList.value = body.users ?? [];
  } catch (e) {
    userLoadError.value = (e as Error).message;
  }
}

async function onCreateUser() {
  userMutationError.value = '';
  creatingUser.value = true;
  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUser.username, password: newUser.password, role: newUser.role }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error ?? `HTTP ${res.status}`);
    }
    newUser.username = '';
    newUser.password = '';
    newUser.role = 'member';
    await loadUsers();
  } catch (e) {
    userMutationError.value = (e as Error).message;
  } finally {
    creatingUser.value = false;
  }
}

async function onDeleteUser(u: UserListEntry) {
  if (!confirm(`确认删除用户 ${u.username}？`)) return;
  userMutationError.value = '';
  try {
    const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error ?? `HTTP ${res.status}`);
    }
    await loadUsers();
  } catch (e) {
    userMutationError.value = (e as Error).message;
  }
}

function openResetPassword(u: UserListEntry) {
  resetTarget.value = u;
  resetPassword.value = '';
  resetError.value = '';
}

async function onConfirmReset() {
  if (!resetTarget.value) return;
  if (resetPassword.value.length < 8) {
    resetError.value = '密码至少 8 位';
    return;
  }
  resettingPw.value = true;
  resetError.value = '';
  try {
    const res = await fetch(`/api/users/${resetTarget.value.id}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: resetPassword.value }),
    });
    if (!res.ok && res.status !== 204) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error ?? `HTTP ${res.status}`);
    }
    resetTarget.value = null;
  } catch (e) {
    resetError.value = (e as Error).message;
  } finally {
    resettingPw.value = false;
  }
}

// --- Per-user permission editor (members only) ---
const CAPABILITIES: { token: string; label: string }[] = [
  { token: 'player.control', label: '播放控制' },
  { token: 'player.queue', label: '队列管理' },
  { token: 'bot.manage', label: '机器人管理' },
  { token: 'platform.auth', label: '平台登录凭据' },
  { token: 'quality', label: '音质设置' },
];

const permEditingId = ref<string | null>(null);
const permLoading = ref(false);
const permSaving = ref(false);
const permError = ref('');
const permDraft = reactive<{ capabilities: string[]; botsAll: boolean; selectedBotIds: string[] }>({
  capabilities: [],
  botsAll: true,
  selectedBotIds: [],
});

async function onTogglePermEditor(u: UserListEntry) {
  if (permEditingId.value === u.id) {
    permEditingId.value = null;
    return;
  }
  permEditingId.value = u.id;
  permError.value = '';
  permLoading.value = true;
  permDraft.capabilities = [];
  permDraft.botsAll = true;
  permDraft.selectedBotIds = [];
  try {
    const res = await fetch(`/api/users/${u.id}/permissions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    permDraft.capabilities = Array.isArray(body.capabilities) ? [...body.capabilities] : [];
    if (body.bots === 'all') {
      permDraft.botsAll = true;
      permDraft.selectedBotIds = [];
    } else {
      permDraft.botsAll = false;
      permDraft.selectedBotIds = Array.isArray(body.bots) ? [...body.bots] : [];
    }
  } catch (e) {
    permError.value = (e as Error).message;
  } finally {
    permLoading.value = false;
  }
}

function toggleCapability(token: string, checked: boolean) {
  const has = permDraft.capabilities.includes(token);
  if (checked && !has) permDraft.capabilities.push(token);
  else if (!checked && has) permDraft.capabilities = permDraft.capabilities.filter((t) => t !== token);
}

function toggleBotSelection(id: string, checked: boolean) {
  const has = permDraft.selectedBotIds.includes(id);
  if (checked && !has) permDraft.selectedBotIds.push(id);
  else if (!checked && has) permDraft.selectedBotIds = permDraft.selectedBotIds.filter((b) => b !== id);
}

async function onSavePermissions(u: UserListEntry) {
  permSaving.value = true;
  permError.value = '';
  try {
    const res = await fetch(`/api/users/${u.id}/permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilities: [...permDraft.capabilities],
        bots: permDraft.botsAll ? 'all' : [...permDraft.selectedBotIds],
      }),
    });
    if (!res.ok && res.status !== 204) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error ?? `HTTP ${res.status}`);
    }
    permEditingId.value = null;
  } catch (e) {
    permError.value = (e as Error).message;
  } finally {
    permSaving.value = false;
  }
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- Audit Log ---
interface AuditEntry {
  id: number;
  timestamp: number;
  actorId: string | null;
  actorUsername: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  action: string;
}

const auditEntries = ref<AuditEntry[]>([]);
const auditLoadError = ref('');
const auditLoading = ref(false);

async function loadAudit() {
  auditLoadError.value = '';
  auditLoading.value = true;
  try {
    const res = await fetch('/api/audit?limit=100');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    auditEntries.value = body.entries ?? [];
  } catch (e) {
    auditLoadError.value = (e as Error).message;
  } finally {
    auditLoading.value = false;
  }
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function describeAction(e: AuditEntry): string {
  const target = e.targetUsername ?? e.targetUserId ?? '—';
  switch (e.action) {
    case 'admin.first_created':     return `创建首位管理员 ${target}`;
    case 'user.created':            return `创建用户 ${target}`;
    case 'user.deleted':            return `删除用户 ${target}`;
    case 'user.password_reset':     return `重置 ${target} 的密码`;
    case 'user.password_changed':   return `修改自己的密码`;
    case 'user.role_changed':       return `变更 ${target} 的角色`;
    case 'user.permissions_changed': return `权限变更 → ${target}`;
    default:                        return `${e.action} → ${target}`;
  }
}

function auditActionClass(action: string): string {
  if (action === 'user.deleted') return 'audit-action-danger';
  if (action === 'user.password_reset' || action === 'user.password_changed') return 'audit-action-warn';
  return 'audit-action-ok';
}

onMounted(() => {
  store.fetchBots(); // Refresh bot status on page visit
  checkAuthStatus();
  loadQuality();
  loadIdleTimeout(); // also populates the Spotify config form (same endpoint)
  loadSpotifyStatus();
  handleSpotifyRedirect();
  if (session.isAdmin.value) {
    loadUsers();
    loadAudit();
  }
});

onUnmounted(() => {
  if (neteaseQr.pollTimer) clearInterval(neteaseQr.pollTimer);
  if (qqQr.pollTimer) clearInterval(qqQr.pollTimer);
  if (bilibiliQr.pollTimer) clearInterval(bilibiliQr.pollTimer);
  if (kugouQr.pollTimer) clearInterval(kugouQr.pollTimer);
});
</script>

<style lang="scss" scoped>
.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  opacity: 0.7;
  margin-bottom: 16px;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}

.page-title {
  font-size: 28px;
  font-weight: 800;
  margin-bottom: 32px;
}

.settings-section {
  margin-bottom: 36px;
  padding: 24px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
}

.section-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 16px;
}

.subsection-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  margin-top: 16px;
}

.setting-row {
  margin-bottom: 16px;
}

.setting-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
}

.setting-icon {
  font-size: 18px;
  opacity: 0.6;
}

.theme-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 600;
  transition: all var(--transition-fast);
  &:hover { background: var(--color-primary); color: white; }
}

// Bot management
.bot-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bot-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
}

.bot-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bot-name {
  font-size: 14px;
  font-weight: 500;
}

.bot-status {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: var(--border-color);
  color: var(--text-tertiary);
  &.online {
    background: var(--color-primary-15);
    color: var(--color-primary);
  }
  &.playing {
    background: var(--color-online-15);
    color: var(--color-online);
  }
  &.paused {
    background: var(--color-paused-15);
    color: var(--color-paused);
  }
}

// Account cards
.account-card {
  margin-bottom: 20px;
  padding: 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
}

.account-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.account-icon {
  font-size: 28px;
  color: var(--color-primary);

  &.bilibili-icon {
    color: var(--brand-bilibili);
  }

  &.kugou-icon {
    color: var(--brand-kugou);
  }

  &.jellyfin-icon {
    color: var(--brand-jellyfin);
  }
}

.account-name {
  font-size: 15px;
  font-weight: 600;
}

.account-status {
  font-size: 12px;
  color: var(--text-tertiary);
  &.logged { color: var(--color-online); }
}

.login-methods {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.login-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  transition: all var(--transition-fast);

  &:hover { border-color: var(--color-primary); color: var(--color-primary); }
  &.active {
    background: var(--color-primary-10);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

// QR code
.qr-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 0;
}

.qr-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 14px;
}

.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.qr-image {
  width: 200px;
  height: 200px;
  border-radius: var(--radius-md);
  border: 2px solid var(--border-color);
}

.qr-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  background: var(--bg-card);

  &.scanned { color: #ff9800; background: rgba(255, 152, 0, 0.1); }
  &.confirmed { color: #4caf50; background: rgba(76, 175, 80, 0.1); }
  &.expired { color: #f44336; background: rgba(244, 67, 54, 0.1); }
}

.btn-link {
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 600;
  text-decoration: underline;
  margin-left: 8px;
}

// Cookie section
.cookie-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.btn-save {
  align-self: flex-end;
}

// --- Spotify (Connect) card ---
.spotify-disclaimer {
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-paused);
  background: var(--color-paused-15);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  margin: -4px 0 16px;
}

.spotify-icon { color: #1db954; }

.account-status {
  &.tone-ok { color: var(--color-online); }
  &.tone-warn { color: var(--color-paused); }
  &.tone-off { color: var(--text-tertiary); }
}

.spotify-toggle { padding-top: 0; margin-bottom: 4px; }
.spotify-row { margin-top: 4px; }

.spotify-btn-group {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.spotify-choice {
  padding: 8px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);

  &:hover { border-color: var(--color-primary); color: var(--color-primary); }
  &.active {
    background: var(--color-primary-10);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
}

.spotify-secret-hint {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary);
  &.set { color: var(--color-online); }
}

.spotify-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}

.spotify-connect {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.spotify-message {
  margin: 10px 0 0;
  font-size: 13px;
  &.tone-ok { color: var(--color-online); }
  &.tone-warn { color: #e26a6a; }
}

// Shared
.form-row {
  display: flex;
  gap: 8px;
}

.input {
  flex: 1;
  padding: 10px 14px;
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  &:focus { border-color: var(--color-primary); }
  &.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

.input-sm { max-width: 80px; }

// The default-source picker holds full source names ("网易云音乐"), so it needs
// more room than the 80px .input-sm cap.
.default-source-select {
  max-width: none;
  flex: 0 0 160px;
}

.textarea {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  resize: vertical;
  &:focus { border-color: var(--color-primary); }
}

.quality-options {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.quality-btn {
  padding: 12px;
  background: var(--hover-bg);
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  text-align: center;
  transition: all var(--transition-fast);
  cursor: pointer;

  &:hover { border-color: var(--border-color); }
  &.active {
    border-color: var(--color-primary);
    background: var(--color-primary-10);
  }
}

.quality-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 2px;
}

.quality-desc {
  font-size: 11px;
  color: var(--text-tertiary);
}

.prefix-input-wrap {
  display: flex;
  gap: 8px;
  align-items: center;
}

.btn-primary {
  padding: 10px 20px;
  background: var(--color-primary);
  color: white;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  transition: transform var(--transition-fast);
  &:hover { transform: scale(1.02); }
  &:active { transform: scale(0.98); }
}

.btn-sm {
  padding: 6px 14px;
  background: var(--hover-bg);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  transition: all var(--transition-fast);
  &:hover { background: var(--color-primary); color: white; }
}

.btn-edit {
  padding: 6px 8px;
  font-size: 14px;
}

.btn-delete {
  padding: 6px 8px;
  font-size: 14px;
  &:hover { background: #f44336; color: white; }
}

.btn-secondary {
  padding: 10px 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
}

.bot-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.create-bot {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.form-group {
  margin-bottom: 12px;
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 4px;
    opacity: 0.7;
  }
}

.edit-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}

.edit-modal {
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  padding: 28px;
  width: 480px;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
}

.modal-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 20px;
}

.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 20px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

// --- Bot Profile section ---
.profile-section-hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin: -8px 0 16px;
  line-height: 1.5;
}

.empty-hint {
  font-size: 13px;
  color: var(--text-tertiary);
  padding: 12px;
}

.profile-bot-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-bot {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.profile-bot-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: transparent;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--transition-fast);

  &:hover { background: var(--hover-bg); }
  &.expanded { background: var(--hover-bg); }
}

.profile-bot-name {
  flex: 1;
  text-align: left;
}

.profile-toggles {
  display: flex;
  flex-direction: column;
  padding: 0 16px 8px;
  border-top: 1px solid var(--border-color);
}

.profile-loading {
  padding: 16px 0;
  font-size: 13px;
  color: var(--text-tertiary);
  text-align: center;
}

.profile-error {
  color: var(--brand-netease); // re-uses red brand color for error state

  .btn-link {
    margin-left: 8px;
    font-size: 13px;
    color: var(--color-primary);
    text-decoration: underline;
    background: transparent;
    cursor: pointer;
  }
}

.profile-toggle {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;

  &:last-child { border-bottom: none; }
}

.profile-toggle-text {
  flex: 1;
  min-width: 0;
}

.profile-toggle-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  line-height: 1.3;
}

.profile-warn-tag {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 6px;
  background: var(--color-paused-15);
  color: var(--color-paused);
  border-radius: var(--radius-xs);
  white-space: nowrap;
}

.profile-toggle-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
  line-height: 1.4;
}

.profile-toggle-switch {
  flex-shrink: 0;
  appearance: none;
  -webkit-appearance: none;
  width: 40px;
  height: 22px;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  position: relative;
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
  margin: 0;

  &::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text-secondary);
    transition: transform var(--transition-fast), background var(--transition-fast);
  }

  &:checked {
    background: var(--color-primary);
    border-color: var(--color-primary);

    &::before {
      transform: translateX(18px);
      background: white;
    }
  }
}

.profile-toggle-static {
  cursor: default;
  align-items: flex-start;
}

// Standalone toggle inside 行为设置 (not part of a bordered list)
.behavior-toggle {
  border-bottom: none;
  padding-top: 4px;
}

.voice-ducking-volume {
  padding: 4px 0 14px;
}

.voice-ducking-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
  line-height: 1.4;
  font-weight: 400;
}

.voice-ducking-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.voice-ducking-range {
  flex: 1 1 240px;
  min-width: 160px;
  accent-color: var(--color-primary);
  cursor: pointer;
}

.voice-ducking-unit {
  font-size: 13px;
  opacity: 0.7;
}

.voice-ducking-message {
  margin: 8px 0 0;
  font-size: 12px;

  &.tone-ok { color: var(--color-online); }
  &.tone-warn { color: #e26a6a; }
}

@media (max-width: 768px) {
  .profile-bot-header {
    padding: 14px 12px;
    font-size: 15px;
  }

  .profile-toggles {
    padding: 0 12px 6px;
  }

  .profile-toggle {
    gap: 12px;
    padding: 14px 0;
  }

  .profile-toggle-switch {
    width: 44px;
    height: 24px;

    &::before {
      width: 18px;
      height: 18px;
    }
    &:checked::before {
      transform: translateX(20px);
    }
  }

  .voice-ducking-controls {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
  }

  .voice-ducking-range {
    flex-basis: auto;
    width: 100%;
  }
}

// --- User Management ---
.user-list { display: flex; flex-direction: column; gap: 8px; }
.user-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px; background: var(--bg-secondary); border-radius: var(--radius-sm);
}
.user-info { display: flex; flex-direction: column; gap: 4px; }
.user-name { font-weight: 500; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
.user-self-badge {
  font-size: 11px; padding: 2px 6px; border-radius: 4px;
  background: var(--color-primary); color: #fff;
}
.user-created { font-size: 12px; color: var(--text-secondary); }
.user-actions { display: flex; gap: 8px; }
.user-add-form {
  display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;
}
.user-add-form .input { flex: 1; min-width: 140px; }
.user-empty, .user-error { font-size: 12px; color: var(--text-secondary); padding: 8px 0; }
.user-error { color: #e26a6a; }
.modal-hint { color: var(--text-secondary); font-size: 12px; margin: 0 0 8px; }
.form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }

.audit-refresh-btn {
  margin-left: 10px;
  border: 0; background: transparent;
  color: var(--text-secondary); cursor: pointer;
  display: inline-flex; align-items: center;
  font-size: 16px;
  &:hover { color: var(--text-primary); }
  &:disabled { opacity: 0.5; cursor: progress; }
}
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.audit-list {
  display: flex; flex-direction: column;
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  max-height: 480px;
  overflow-y: auto;
}
.audit-row {
  display: grid;
  grid-template-columns: 170px 120px 1fr;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: 13px;
  &:last-child { border-bottom: 0; }
}
.audit-time {
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  white-space: nowrap;
}
.audit-actor {
  color: var(--text-primary);
  font-weight: 500;
}
.audit-action { color: var(--text-primary); }
.audit-action-ok      { color: var(--text-primary); }
.audit-action-warn    { color: #d3a44b; }
.audit-action-danger  { color: #e26a6a; }

@media (max-width: 640px) {
  .audit-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}

.user-role-badge {
  font-size: 11px; padding: 2px 6px; border-radius: 4px; margin-left: 6px;
  font-weight: 500;
}
.role-admin { background: rgba(99, 145, 226, 0.18); color: #6391e2; }
.role-member { background: rgba(150, 150, 150, 0.18); color: var(--text-secondary); }
.user-role-select { flex: 0 0 110px; }

.user-row-wrap { display: flex; flex-direction: column; gap: 0; }
.perm-admin-label { font-size: 12px; color: var(--text-secondary); align-self: center; }
.perm-editor {
  margin-top: -2px;
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.perm-group { display: flex; flex-direction: column; gap: 8px; }
.perm-group-title { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.perm-checks { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.perm-bots { padding-left: 16px; }
.perm-check {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; color: var(--text-secondary); cursor: pointer;
}
.perm-check input { cursor: pointer; }

// --- Account section (own password change) ---
.account-info-card {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px; background: var(--bg-secondary); border-radius: var(--radius-sm);
  margin-bottom: 12px;
}
.account-row {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 13px;
}
.account-label { color: var(--text-secondary); }
.account-value { color: var(--text-primary); font-weight: 500; }
.change-pw-form {
  display: flex; flex-direction: column; gap: 8px;
  max-width: 360px;
}
.change-pw-form .input { width: 100%; }
.change-pw-form button { align-self: flex-start; }
.user-success { color: #4caf7a; font-size: 13px; margin: 4px 0 0; }
</style>
